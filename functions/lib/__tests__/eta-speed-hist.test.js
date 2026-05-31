const speedHist = require("../eta-speed-hist");
const { speedForLineHour, DEFAULT_SPEED_KMH, _resetCacheForTest } = speedHist;

function mockAdmin(data) {
  return {
    firestore: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: data !== null, data: () => data }),
        }),
      }),
    }),
  };
}

beforeEach(() => _resetCacheForTest());

describe("eta-speed-hist · v_hist lookup (GPS-derivado)", () => {
  test("bucket exacto línea×hora", async () => {
    const admin = mockAdmin({ buckets: { "183|0": 22, "183|2": 11 } });
    expect(await speedForLineHour({ line: "183", hourBand: 0, admin }))
      .toEqual({ speedKmh: 22, source: "line-hour" });
  });

  test("fallback a promedio de la hora cuando falta la línea", async () => {
    const admin = mockAdmin({ buckets: { "183|0": 22, "100|0": 18 } });
    // hourAvg["0"] = (22+18)/2 = 20
    expect(await speedForLineHour({ line: "999", hourBand: 0, admin }))
      .toEqual({ speedKmh: 20, source: "hour" });
  });

  test("fallback a default global cuando el doc no existe", async () => {
    const admin = mockAdmin(null);
    expect(await speedForLineHour({ line: "183", hourBand: 0, admin }))
      .toEqual({ speedKmh: DEFAULT_SPEED_KMH, source: "default" });
  });

  test("fallback a default cuando no hay datos de esa hora", async () => {
    const admin = mockAdmin({ buckets: { "183|0": 22 } });
    const r = await speedForLineHour({ line: "999", hourBand: 3, admin });
    expect(r.source).toBe("default");
    expect(r.speedKmh).toBe(DEFAULT_SPEED_KMH);
  });

  test("clamp físico: valores fuera de [5,50] se acotan", async () => {
    const admin = mockAdmin({ buckets: { "A|0": 3, "B|0": 70 } });
    expect((await speedForLineHour({ line: "A", hourBand: 0, admin })).speedKmh).toBe(5);
    _resetCacheForTest();
    const admin2 = mockAdmin({ buckets: { "A|0": 3, "B|0": 70 } });
    expect((await speedForLineHour({ line: "B", hourBand: 0, admin: admin2 })).speedKmh).toBe(50);
  });

  test("degrada graceful si Firestore tira error", async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ get: async () => { throw new Error("firestore down"); } }) }) }) };
    expect(await speedForLineHour({ line: "183", hourBand: 0, admin }))
      .toEqual({ speedKmh: DEFAULT_SPEED_KMH, source: "default" });
  });
});
