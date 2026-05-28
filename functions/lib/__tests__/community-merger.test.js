/**
 * Tests del merger comunidad↔IMM para `/buses` global (Función 2).
 *
 * Sin Firestore. Sin admin. Los inputs son shapes mockeados directos.
 */

const merger = require("../community-merger");

const NOW = new Date("2026-05-27T20:00:00Z");
const NOW_MS = NOW.getTime();

/* ─── factories ─── */

function immBus({
  busId = "B12345",
  line = "121",
  lineVariantId = 1001,
  lat = -34.9011,
  lng = -56.1645,
  extra = {},
} = {}) {
  return {
    busId,
    line,
    lineVariantId,
    location: { type: "Point", coordinates: [lng, lat] },
    ...extra,
  };
}

function communityReport({
  id,
  userId,
  line = "121",
  lineVariantId = 1001,
  lat = -34.9011,
  lng = -56.1645,
  company = "CUTCSA",
  speed = 5,
  ageSec = 10,
  officialBusId = null,
} = {}) {
  return {
    id,
    userId,
    line,
    lineVariantId,
    lat,
    lng,
    speed,
    company,
    updatedAt: { toMillis: () => NOW_MS - ageSec * 1000 },
    startedAt: { toMillis: () => NOW_MS - 60_000 },
    officialBusId,
  };
}

function clusterFrom(reports) {
  const rep = reports[0];
  const reporterIds = new Set(reports.map((r) => r.userId).filter(Boolean));
  return {
    representative: rep,
    reporterIds,
    reporterCount: reporterIds.size,
    officialBusId: reports.find((r) => r.officialBusId)?.officialBusId || null,
  };
}

function clustersByLineFrom(...allClusters) {
  const map = new Map();
  for (const c of allClusters) {
    const ln = c.representative.line;
    if (!map.has(ln)) map.set(ln, []);
    map.get(ln).push(c);
  }
  return map;
}

/* ─── mergeImmWithCommunity ─── */

describe("mergeImmWithCommunity", () => {
  test("0 IMM + 0 com → empty merged", () => {
    const r = merger.mergeImmWithCommunity({
      immBuses: [], clustersByLine: new Map(), now: NOW,
    });
    expect(r.mergedBuses).toEqual([]);
    expect(r.stats).toEqual({ immCount: 0, mixedCount: 0, pureCommunityCount: 0, totalCount: 0 });
  });

  test("1 IMM + 0 com → 1 bus source='imm'", () => {
    const r = merger.mergeImmWithCommunity({
      immBuses: [immBus()], clustersByLine: new Map(), now: NOW,
    });
    expect(r.mergedBuses).toHaveLength(1);
    expect(r.mergedBuses[0].source).toBe("imm");
    expect(r.stats.mixedCount).toBe(0);
  });

  test("0 IMM + 1 com fresh → 1 pure-community", () => {
    const c = clusterFrom([communityReport({ id: "R1", userId: "u1" })]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
    });
    expect(r.mergedBuses).toHaveLength(1);
    const b = r.mergedBuses[0];
    expect(b.source).toBe("community");
    expect(b.busId).toBe("community:R1");
    expect(b.position).toBe(-1);
    expect(b.communityConfirmations).toBe(1);
    expect(r.stats.pureCommunityCount).toBe(1);
  });

  test("0 IMM + 1 com stale (>90s) → 0 buses", () => {
    const c = clusterFrom([communityReport({ id: "R1", userId: "u1", ageSec: 120 })]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
    });
    expect(r.mergedBuses).toEqual([]);
    expect(r.stats.pureCommunityCount).toBe(0);
  });

  test("1 IMM + 1 com matchea (misma línea + variante + coord) → 1 mixto, 0 pure", () => {
    const c = clusterFrom([
      communityReport({ id: "R1", userId: "u1", line: "121", lineVariantId: 1001, lat: -34.9011, lng: -56.1645 }),
    ]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [immBus({ line: "121", lineVariantId: 1001, lat: -34.9012, lng: -56.1646 })],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
      immAgeSec: 15, // fresh
    });
    expect(r.mergedBuses).toHaveLength(1);
    const b = r.mergedBuses[0];
    expect(b.source).toBe("imm+community");
    expect(b.communityConfirmations).toBe(1);
    expect(b.communityClusterId).toBe("R1");
    expect(b.communityMergeNote).toBeUndefined(); // IMM fresh → no override
    expect(r.stats.mixedCount).toBe(1);
    expect(r.stats.pureCommunityCount).toBe(0);
  });

  test("IMM stale (>30s) + match → coords overridden con nota", () => {
    const c = clusterFrom([
      communityReport({ id: "R1", userId: "u1", line: "121", lineVariantId: 1001, lat: -34.902, lng: -56.165 }),
    ]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [immBus({ line: "121", lineVariantId: 1001, lat: -34.9011, lng: -56.1645 })],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
      immAgeSec: 60, // stale
    });
    const b = r.mergedBuses[0];
    expect(b.source).toBe("imm+community");
    expect(b.communityMergeNote).toBe("coords-from-community");
    // Coord es [lng, lat] — debe haber cambiado del input IMM original
    expect(b.location.coordinates[0]).not.toBe(-56.1645);
  });

  test("1 IMM + 1 com de OTRA línea → 1 IMM + 1 pure-community", () => {
    const c = clusterFrom([
      communityReport({ id: "R1", userId: "u1", line: "199", lineVariantId: 9999 }),
    ]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [immBus({ line: "121", lineVariantId: 1001 })],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
    });
    expect(r.mergedBuses).toHaveLength(2);
    expect(r.stats.immCount).toBe(1);
    expect(r.stats.mixedCount).toBe(0);
    expect(r.stats.pureCommunityCount).toBe(1);
    const imm = r.mergedBuses.find((b) => b.source === "imm");
    const com = r.mergedBuses.find((b) => b.source === "community");
    expect(imm).toBeDefined();
    expect(com).toBeDefined();
  });

  test("match por officialBusId aunque coords lejos", () => {
    // Comunidad reporta lejos del IMM, pero officialBusId apunta al mismo bus.
    const c = clusterFrom([
      communityReport({
        id: "R1", userId: "u1", line: "121", lineVariantId: 1001,
        lat: -34.95, lng: -56.20, // lejos
        officialBusId: "B12345",
      }),
    ]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [immBus({ busId: "B12345", line: "121", lineVariantId: 1001, lat: -34.9011, lng: -56.1645 })],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
    });
    expect(r.mergedBuses).toHaveLength(1);
    expect(r.mergedBuses[0].source).toBe("imm+community");
  });

  test("cluster con lat/lng inválidos → skipped", () => {
    const c = clusterFrom([communityReport({ id: "R1", userId: "u1", lat: NaN, lng: NaN })]);
    const r = merger.mergeImmWithCommunity({
      immBuses: [],
      clustersByLine: clustersByLineFrom(c),
      now: NOW,
    });
    expect(r.mergedBuses).toEqual([]);
  });

  test("inputs inválidos no rompen", () => {
    const r1 = merger.mergeImmWithCommunity({ immBuses: null, clustersByLine: null, now: NOW });
    expect(r1.mergedBuses).toEqual([]);
    const r2 = merger.mergeImmWithCommunity({});
    expect(r2.mergedBuses).toEqual([]);
  });
});

/* ─── filterByCurrentUser ─── */

describe("filterByCurrentUser", () => {
  function pureCom(busId) { return { busId, source: "community" }; }
  function mixed(busId)   { return { busId, source: "imm+community", communityClusterId: busId.replace("community:","") }; }
  function imm(busId)     { return { busId, source: "imm" }; }

  test("sin currentUid → passthrough", () => {
    const r = merger.filterByCurrentUser({
      buses: [imm("B1"), pureCom("community:R1")],
      currentUid: null,
      clustersByLine: new Map(),
    });
    expect(r.buses).toHaveLength(2);
    expect(r.filteredCount).toBe(0);
  });

  test("currentUid no es reporter de nada → passthrough", () => {
    const c = clusterFrom([communityReport({ id: "R1", userId: "OTHER" })]);
    const r = merger.filterByCurrentUser({
      buses: [pureCom("community:R1")],
      currentUid: "ME",
      clustersByLine: clustersByLineFrom(c),
    });
    expect(r.buses).toHaveLength(1);
    expect(r.filteredCount).toBe(0);
  });

  test("currentUid es reporter de cluster con pure-community → excluido", () => {
    const c = clusterFrom([communityReport({ id: "R1", userId: "ME" })]);
    const r = merger.filterByCurrentUser({
      buses: [pureCom("community:R1"), imm("B1")],
      currentUid: "ME",
      clustersByLine: clustersByLineFrom(c),
    });
    expect(r.buses).toHaveLength(1);
    expect(r.buses[0].busId).toBe("B1");
    expect(r.filteredCount).toBe(1);
  });

  test("currentUid es reporter de cluster matcheado con IMM (bus mixto) → NO excluido", () => {
    // El bus mixto tiene busId del IMM, no empieza con "community:". El filter
    // solo descarta pure-community. iOS recibe el mixto y agrega su listener
    // propio sin duplicar (officialBusId match).
    const c = clusterFrom([communityReport({ id: "R1", userId: "ME" })]);
    const r = merger.filterByCurrentUser({
      buses: [mixed("B12345"), imm("B1")],
      currentUid: "ME",
      clustersByLine: clustersByLineFrom(c),
    });
    expect(r.buses).toHaveLength(2);
    expect(r.filteredCount).toBe(0);
  });

  test("buses vacíos → no rompe", () => {
    const r = merger.filterByCurrentUser({
      buses: [],
      currentUid: "ME",
      clustersByLine: new Map(),
    });
    expect(r.buses).toEqual([]);
    expect(r.filteredCount).toBe(0);
  });
});
