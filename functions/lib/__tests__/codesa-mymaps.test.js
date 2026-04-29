/**
 * Tests del adapter CODESA enriquecido (parsing HTML + distribución de
 * paradas sobre LineString). Cubre los pure helpers — `buildSnapshot()` se
 * skipea porque hace network real.
 */

const codesa = require("../adapters/codesa-mymaps");

describe("htmlPagePathFor", () => {
  test("sentido bi (loop) → sin sufijo", () => {
    expect(codesa.htmlPagePathFor("1", "bi")).toBe(
      "https://www.codesa.com.uy/p/linea-1.html"
    );
    expect(codesa.htmlPagePathFor("l48", "bi")).toBe(
      "https://www.codesa.com.uy/p/linea-l48.html"
    );
  });

  test("sentido ida/vuelta → con sufijo", () => {
    expect(codesa.htmlPagePathFor("6-san-carlos", "ida")).toBe(
      "https://www.codesa.com.uy/p/linea-6-san-carlos-ida.html"
    );
    expect(codesa.htmlPagePathFor("3", "vuelta")).toBe(
      "https://www.codesa.com.uy/p/linea-3-vuelta.html"
    );
  });
});

describe("parseStopNamesFromHtml", () => {
  test("extrae bloque invierno preferido sobre verano", () => {
    const html = `
      <div class="post-body">
        Línea 6 - IDA (invierno - desde marzo a diciembre de cada año)
        Vialidad, Ruta 39, Av. Rocha, Pocitos.

        Línea 6 - IDA (verano - desde diciembre a marzo)
        Vialidad, Ruta 39, Av. Rocha, Punta del Este.
      </div>
    `;
    const r = codesa.parseStopNamesFromHtml(html);
    expect(r.variant).toBe("invierno");
    expect(r.stopNames.map((s) => s.name)).toContain("Pocitos");
    expect(r.stopNames.map((s) => s.name)).not.toContain("Punta del Este");
  });

  test("extrae código de parada de paréntesis '(N)'", () => {
    const html = `
      Línea 1 - IDA (invierno)
      Vialidad, Av. Rocha, Baupres (18), Capitán Miranda (7).
    `;
    const r = codesa.parseStopNamesFromHtml(html);
    const baupres = r.stopNames.find((s) => s.name === "Baupres");
    expect(baupres).toBeDefined();
    expect(baupres.code).toBe("18");
  });

  test("preserva paréntesis no numéricos como parte del nombre", () => {
    const html = `
      Línea 1 - IDA (invierno)
      Carlos Seijo (ruta vieja), Av. Rocha.
    `;
    const r = codesa.parseStopNamesFromHtml(html);
    const seijo = r.stopNames.find((s) => s.name.startsWith("Carlos Seijo"));
    expect(seijo).toBeDefined();
    expect(seijo.name).toBe("Carlos Seijo (ruta vieja)");
    expect(seijo.code).toBeNull();
  });

  test("limpia punto final correctamente (regression bug 2026-04-27)", () => {
    const html = `
      Línea X (invierno)
      Vialidad, Av. Rocha, Capitán Miranda (7).
    `;
    const r = codesa.parseStopNamesFromHtml(html);
    const last = r.stopNames[r.stopNames.length - 1];
    expect(last.name).toBe("Capitán Miranda");
    expect(last.code).toBe("7");
  });

  test("HTML sin descripción → array vacío", () => {
    const r = codesa.parseStopNamesFromHtml("<html><body><h1>404</h1></body></html>");
    expect(r.stopNames).toEqual([]);
  });
});

describe("distributeStopsOnLineString", () => {
  test("distribuye N paradas sobre LineString uniforme", () => {
    const lineString = [
      [-34.90, -56.20],
      [-34.91, -56.19],
      [-34.92, -56.18],
      [-34.93, -56.17],
      [-34.94, -56.16],
    ];
    const stops = [
      { name: "Inicio", code: null },
      { name: "Mitad",  code: null },
      { name: "Fin",    code: null },
    ];
    const distributed = codesa.distributeStopsOnLineString(stops, lineString);
    expect(distributed).toHaveLength(3);
    expect(distributed[0].name).toBe("Inicio");
    expect(distributed[2].name).toBe("Fin");
    // Primer stop = primer punto del LineString
    expect(distributed[0].lat).toBeCloseTo(-34.90, 4);
    expect(distributed[0].lng).toBeCloseTo(-56.20, 4);
    // Último stop = último punto del LineString
    expect(distributed[2].lat).toBeCloseTo(-34.94, 4);
    expect(distributed[2].lng).toBeCloseTo(-56.16, 4);
    // Sequence numerada 1..N
    expect(distributed.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  test("paradas vacías → array vacío", () => {
    expect(codesa.distributeStopsOnLineString([], [[0, 0], [1, 1]])).toEqual([]);
  });

  test("LineString muy corto (1 punto) → array vacío", () => {
    expect(codesa.distributeStopsOnLineString([{ name: "X", code: null }], [[0, 0]])).toEqual([]);
  });
});
