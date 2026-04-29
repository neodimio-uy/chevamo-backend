/**
 * Tests del compositor `transport-graph.js`. Es la lógica más crítica del
 * modelo nuevo Jurisdiction/MetroArea/NationalNetwork/Operator — si esto
 * falla, la resolución de "qué feeds aplican a X jurisdicción" rompe.
 */

const tg = require("../transport-graph");
const { JURISDICTIONS } = require("../jurisdictions");
const { METRO_AREAS } = require("../metro-areas");
const { OPERATORS } = require("../operators");

describe("transport-graph.resolveJurisdiction", () => {
  test("Mvd resuelve con IMM + MTOP + larga distancia", () => {
    const r = tg.resolveJurisdiction("uy.mvd");
    expect(r).not.toBeNull();
    expect(r.jurisdiction.id).toBe("uy.mvd");
    expect(r.metroAreas.map((m) => m.id)).toContain("uy.mvd-area-metro");
    expect(r.nationalNetworks.map((n) => n.id)).toContain("uy.long-distance");
    const opIds = r.operators.map((o) => o.id);
    expect(opIds).toContain("imm");
    expect(opIds).toContain("mtop");
  });

  test("Canelones hereda STM urbano vía metroArea (líneas D9/G/710 cubren Canelones)", () => {
    const r = tg.resolveJurisdiction("uy.canelones");
    expect(r).not.toBeNull();
    const busUrban = r.modes.find(
      (m) => m.mode === "bus" && m.service === "urban"
    );
    expect(busUrban).toBeDefined();
    expect(busUrban.dataMode).toBe("official");
    expect(busUrban.operators).toContain("imm");
  });

  test("CABA tiene bus + subte + bike (todos GCBA)", () => {
    const r = tg.resolveJurisdiction("ar.caba");
    expect(r).not.toBeNull();
    const modeNames = r.modes.map((m) => m.mode);
    expect(modeNames).toContain("bus");
    expect(modeNames).toContain("subte");
    expect(modeNames).toContain("bike");
  });

  test("GBA tiene SOLO bus (subte y bike restringidos a CABA por feed.coverage)", () => {
    const r = tg.resolveJurisdiction("ar.gba");
    expect(r).not.toBeNull();
    const modeNames = r.modes.map((m) => m.mode);
    expect(modeNames).toContain("bus");
    expect(modeNames).not.toContain("subte");
    expect(modeNames).not.toContain("bike");
  });

  test("jurisdictionId desconocido devuelve null", () => {
    expect(tg.resolveJurisdiction("xx.unknown")).toBeNull();
    expect(tg.resolveJurisdiction("")).toBeNull();
  });
});

describe("transport-graph.resolveMetroArea", () => {
  test("Mvd Area Metro tiene 3 jurisdicciones", () => {
    const r = tg.resolveMetroArea("uy.mvd-area-metro");
    expect(r).not.toBeNull();
    const jids = r.jurisdictions.map((j) => j.id);
    expect(jids).toEqual(
      expect.arrayContaining(["uy.mvd", "uy.canelones", "uy.san-jose"])
    );
  });

  test("AMBA tiene CABA + GBA", () => {
    const r = tg.resolveMetroArea("ar.amba");
    expect(r).not.toBeNull();
    const jids = r.jurisdictions.map((j) => j.id);
    expect(jids).toEqual(expect.arrayContaining(["ar.caba", "ar.gba"]));
  });

  test("metroAreaId desconocido devuelve null", () => {
    expect(tg.resolveMetroArea("xx.unknown")).toBeNull();
  });
});

describe("transport-graph.resolveLocation", () => {
  test("Plaza Independencia (Mvd) → uy.mvd", () => {
    const r = tg.resolveLocation(-34.9058, -56.1913);
    expect(r).not.toBeNull();
    expect(r.jurisdiction.id).toBe("uy.mvd");
  });

  test("Sol (Madrid) → es.madrid", () => {
    const r = tg.resolveLocation(40.4168, -3.7038);
    expect(r).not.toBeNull();
    expect(r.jurisdiction.id).toBe("es.madrid");
  });

  test("Coord en oceano → null", () => {
    expect(tg.resolveLocation(0, 0)).toBeNull();
    expect(tg.resolveLocation(-50, -100)).toBeNull();
  });
});

describe("transport-graph.deriveModes", () => {
  test("multi-operator merge eleva dataMode (staticOnly + communityOnly → staticOnly)", () => {
    // Madrid tiene CRTM (staticOnly) + EMT (communityOnly) para bus.urban
    const r = tg.resolveJurisdiction("es.madrid");
    const busUrban = r.modes.find(
      (m) => m.mode === "bus" && m.service === "urban"
    );
    expect(busUrban).toBeDefined();
    expect(busUrban.dataMode).toBe("staticOnly");
    expect(busUrban.operators.sort()).toEqual(["crtm", "emt-madrid"].sort());
  });

  test("operators del mismo feed quedan deduped", () => {
    const r = tg.resolveJurisdiction("uy.mvd");
    // bus.suburban está en IMM (RT) + MTOP (static). dataMode merge oficial > staticOnly
    const busSub = r.modes.find(
      (m) => m.mode === "bus" && m.service === "suburban"
    );
    expect(busSub.dataMode).toBe("official");
    expect(busSub.operators.sort()).toEqual(["imm", "mtop"].sort());
  });
});

describe("transport-graph.getActiveFeedsForJurisdictionMode", () => {
  test("Mvd bus.urban devuelve feed RT imm-stm", () => {
    const feeds = tg.getActiveFeedsForJurisdictionMode("uy.mvd", "bus", "urban");
    expect(feeds.length).toBeGreaterThan(0);
    expect(feeds[0].adapterId).toBe("imm-stm");
  });

  test("Madrid bus.urban devuelve [] (no hay RT, solo staticOnly)", () => {
    const feeds = tg.getActiveFeedsForJurisdictionMode("es.madrid", "bus", "urban");
    // CRTM y EMT no tienen adapterId RT — solo staticFeedId
    expect(feeds.length).toBe(0);
  });

  test("CABA bus devuelve gcba-vehicles-simple", () => {
    const feeds = tg.getActiveFeedsForJurisdictionMode("ar.caba", "bus", "urban");
    expect(feeds.some((f) => f.adapterId === "gcba-vehicles-simple")).toBe(true);
  });

  test("GBA subte devuelve [] (subte solo CABA)", () => {
    const feeds = tg.getActiveFeedsForJurisdictionMode("ar.gba", "subte", "urban");
    expect(feeds).toEqual([]);
  });
});

describe("Catalog integrity (sanidad de los catálogos)", () => {
  test("Todas las jurisdicciones tienen id, country, bbox válido", () => {
    for (const j of JURISDICTIONS) {
      expect(j.id).toMatch(/^[a-z]{2}\./);
      expect(j.country).toMatch(/^[A-Z]{2}$/);
      expect(j.boundingBox.swLat).toBeLessThan(j.boundingBox.neLat);
      expect(j.boundingBox.swLng).toBeLessThan(j.boundingBox.neLng);
    }
  });

  test("Todos los metroAreas referencian jurisdicciones existentes", () => {
    const jurisIds = new Set(JURISDICTIONS.map((j) => j.id));
    for (const m of METRO_AREAS) {
      for (const jid of m.jurisdictionIds) {
        expect(jurisIds.has(jid)).toBe(true);
      }
    }
  });

  test("Todos los operators referencian jurisdicciones existentes en coverage", () => {
    const jurisIds = new Set(JURISDICTIONS.map((j) => j.id));
    for (const op of OPERATORS) {
      for (const jid of op.coverage.jurisdictions || []) {
        expect(jurisIds.has(jid)).toBe(true);
      }
    }
  });
});
