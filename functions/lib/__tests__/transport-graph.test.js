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
  test("Mvd resuelve con IMM", () => {
    const r = tg.resolveJurisdiction("uy.mvd");
    expect(r).not.toBeNull();
    expect(r.jurisdiction.id).toBe("uy.mvd");
    expect(r.metroAreas.map((m) => m.id)).toContain("uy.mvd-area-metro");
    const opIds = r.operators.map((o) => o.id);
    expect(opIds).toContain("imm");
  });

  test("jurisdictionId desconocido devuelve null", () => {
    expect(tg.resolveJurisdiction("xx.unknown")).toBeNull();
    expect(tg.resolveJurisdiction("")).toBeNull();
  });
});

describe("transport-graph.resolveMetroArea", () => {
  test("Mvd Area Metro tiene Mvd", () => {
    const r = tg.resolveMetroArea("uy.mvd-area-metro");
    expect(r).not.toBeNull();
    const jids = r.jurisdictions.map((j) => j.id);
    expect(jids).toEqual(expect.arrayContaining(["uy.mvd"]));
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

  test("Coord en oceano → null", () => {
    expect(tg.resolveLocation(0, 0)).toBeNull();
    expect(tg.resolveLocation(-50, -100)).toBeNull();
  });
});

describe("transport-graph.getActiveFeedsForJurisdictionMode", () => {
  test("Mvd bus.urban devuelve feed RT imm-stm", () => {
    const feeds = tg.getActiveFeedsForJurisdictionMode("uy.mvd", "bus", "urban");
    expect(feeds.length).toBeGreaterThan(0);
    expect(feeds[0].adapterId).toBe("imm-stm");
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
