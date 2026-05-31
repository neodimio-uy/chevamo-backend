const { pickBase, computeTrafficFactor } = require("../eta-fusion");

describe("pickBase (fix Unif: aceptar eta:0 = bus llegando ahora)", () => {
  test("eta > 0 usa IMM", () => {
    expect(pickBase({ eta: 120 })).toEqual({ baseEtaSec: 120, source: "imm" });
  });

  test("eta === 0 usa IMM (antes se descartaba con eta>0)", () => {
    // Regresión del bug: bus a ~114m con eta:0 desaparecía de /upcoming.
    expect(pickBase({ eta: 0 })).toEqual({ baseEtaSec: 0, source: "imm" });
  });

  test("eta:0 tiene precedencia sobre googleEtaSec", () => {
    expect(pickBase({ eta: 0, googleEtaSec: 300 })).toEqual({ baseEtaSec: 0, source: "imm" });
  });

  test("eta negativo (inválido) cae a Google si existe", () => {
    expect(pickBase({ eta: -5, googleEtaSec: 240 })).toEqual({ baseEtaSec: 240, source: "google" });
  });

  test("sin eta numérico usa Google", () => {
    expect(pickBase({ googleEtaSec: 200 })).toEqual({ baseEtaSec: 200, source: "google" });
  });

  test("sin ninguna base devuelve none", () => {
    expect(pickBase({})).toEqual({ baseEtaSec: null, source: "none" });
    expect(pickBase({ eta: null, googleEtaSec: 0 })).toEqual({ baseEtaSec: null, source: "none" });
  });
});

describe("computeTrafficFactor (se computa siempre; la aplicación la gatea el flag)", () => {
  test("no aplica cuando falta alguna fuente", () => {
    expect(computeTrafficFactor({ eta: 120 })).toEqual({ factor: 1.0, applied: false });
  });

  test("no aplica cuando el delta es chico (<60s)", () => {
    expect(computeTrafficFactor({ eta: 120, googleEtaSec: 140 })).toEqual({ factor: 1.0, applied: false });
  });

  test("aplica (raw) cuando el delta es significativo y ambos > 0", () => {
    const r = computeTrafficFactor({ eta: 120, googleEtaSec: 300 });
    expect(r.applied).toBe(true);
    expect(r.factor).toBeGreaterThan(1.0);
  });

  test("no aplica con eta:0 (evita división degenerada)", () => {
    expect(computeTrafficFactor({ eta: 0, googleEtaSec: 300 })).toEqual({ factor: 1.0, applied: false });
  });
});
