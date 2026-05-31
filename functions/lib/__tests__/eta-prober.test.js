const { uyHour, sampleK } = require("../eta-prober");

describe("eta-prober helpers", () => {
  test("uyHour convierte UTC → Uruguay (UTC-3)", () => {
    expect(uyHour(new Date("2026-05-31T14:00:00Z"))).toBe(11);
    expect(uyHour(new Date("2026-05-31T02:00:00Z"))).toBe(23); // cruza medianoche
    expect(uyHour(new Date("2026-05-31T08:00:00Z"))).toBe(5);
  });

  test("sampleK devuelve a lo sumo k elementos, todos del arreglo", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = sampleK(arr, 3);
    expect(s).toHaveLength(3);
    s.forEach((x) => expect(arr).toContain(x));
    expect(new Set(s).size).toBe(3); // sin repetidos
  });

  test("sampleK no excede el tamaño del arreglo", () => {
    expect(sampleK([1, 2], 5)).toHaveLength(2);
    expect(sampleK([], 5)).toHaveLength(0);
  });
});
