/**
 * Tests para transformDirections — verifica que el JSON de Google Directions
 * se transforma correctamente al formato que espera la app iOS.
 *
 * Correr: node test-transform.js
 */

// Extraer la función del index.js (sin firebase deps)
// Copiamos la lógica aquí para testear sin Cloud Functions runtime

function formatTime(epoch) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function transformDirections(googleData) {
  if (!googleData || !googleData.routes) return { routes: [], status: googleData?.status || "UNKNOWN" };

  const routes = googleData.routes.map(route => {
    const leg = route.legs?.[0];
    if (!leg) return null;

    const steps = [];
    for (const step of leg.steps || []) {
      if (step.travel_mode === "WALKING") {
        steps.push({
          type: "walk",
          instruction: step.html_instructions?.replace(/<[^>]*>/g, "") || "Caminar",
          durationMin: Math.round((step.duration?.value || 0) / 60),
          distanceM: step.distance?.value || 0,
          polyline: step.polyline?.points || "",
        });
      } else if (step.travel_mode === "TRANSIT") {
        const transit = step.transit_details;
        const vehicle = transit?.line?.vehicle?.type || "";
        const isBus = vehicle === "BUS" || vehicle === "TROLLEYBUS";
        steps.push({
          type: isBus ? "bus" : "bus",
          instruction: step.html_instructions?.replace(/<[^>]*>/g, "") || "",
          durationMin: Math.round((step.duration?.value || 0) / 60),
          distanceM: step.distance?.value || 0,
          polyline: step.polyline?.points || "",
          line: transit?.line?.short_name || transit?.line?.name || "",
          lineFullName: transit?.line?.name || "",
          company: (transit?.line?.agencies?.[0]?.name || "").replace(/,.*/, ""),
          headsign: transit?.headsign || "",
          departureStop: transit?.departure_stop?.name || "",
          arrivalStop: transit?.arrival_stop?.name || "",
          departureTime: formatTime(transit?.departure_time?.value),
          arrivalTime: formatTime(transit?.arrival_time?.value),
          numStops: transit?.num_stops || 0,
        });
      }
    }

    return {
      summary: route.summary || "",
      totalDurationMin: Math.round((leg.duration?.value || 0) / 60),
      totalDistanceM: leg.distance?.value || 0,
      departureTime: formatTime(leg.departure_time?.value),
      arrivalTime: formatTime(leg.arrival_time?.value),
      startAddress: leg.start_address || "",
      endAddress: leg.end_address || "",
      polyline: route.overview_polyline?.points || "",
      steps,
    };
  }).filter(Boolean);

  return { routes, status: googleData.status || "OK" };
}

// ─── Tests ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Test 1: null/undefined input
{
  const r = transformDirections(null);
  assertEqual(r.routes.length, 0, "null input returns empty routes");
  assertEqual(r.status, "UNKNOWN", "null input status is UNKNOWN");
}

// Test 2: empty routes
{
  const r = transformDirections({ routes: [], status: "ZERO_RESULTS" });
  assertEqual(r.routes.length, 0, "empty routes array");
  assertEqual(r.status, "ZERO_RESULTS", "preserves original status");
}

// Test 3: basic walking route
{
  const r = transformDirections({
    status: "OK",
    routes: [{
      summary: "",
      overview_polyline: { points: "abc123" },
      legs: [{
        duration: { value: 600 },
        distance: { value: 500 },
        departure_time: { value: 1713150000 },
        arrival_time: { value: 1713150600 },
        start_address: "Origen",
        end_address: "Destino",
        steps: [{
          travel_mode: "WALKING",
          html_instructions: "Camina <b>200 m</b> hacia el norte",
          duration: { value: 180 },
          distance: { value: 200 },
          polyline: { points: "walk_poly" },
        }],
      }],
    }],
  });

  assertEqual(r.routes.length, 1, "one route");
  assertEqual(r.routes[0].totalDurationMin, 10, "10 min total");
  assertEqual(r.routes[0].totalDistanceM, 500, "500m total");
  assertEqual(r.routes[0].polyline, "abc123", "overview polyline");
  assertEqual(r.routes[0].startAddress, "Origen", "start address");
  assertEqual(r.routes[0].steps.length, 1, "one step");
  assertEqual(r.routes[0].steps[0].type, "walk", "walk step type");
  assertEqual(r.routes[0].steps[0].instruction, "Camina 200 m hacia el norte", "HTML tags stripped");
  assertEqual(r.routes[0].steps[0].durationMin, 3, "3 min walk");
  assertEqual(r.routes[0].steps[0].distanceM, 200, "200m walk");
}

// Test 4: transit step
{
  const r = transformDirections({
    status: "OK",
    routes: [{
      summary: "",
      overview_polyline: { points: "poly" },
      legs: [{
        duration: { value: 1200 },
        distance: { value: 5000 },
        departure_time: { value: 1713150000 },
        arrival_time: { value: 1713151200 },
        start_address: "A",
        end_address: "B",
        steps: [{
          travel_mode: "TRANSIT",
          html_instructions: "Bus 109",
          duration: { value: 900 },
          distance: { value: 4500 },
          polyline: { points: "bus_poly" },
          transit_details: {
            line: {
              short_name: "109",
              name: "Ciudad Vieja - Cerro",
              vehicle: { type: "BUS" },
              agencies: [{ name: "Cutcsa, Montevideo" }],
            },
            headsign: "Cerro",
            departure_stop: { name: "Plaza Independencia" },
            arrival_stop: { name: "Terminal Cerro" },
            departure_time: { value: 1713150060 },
            arrival_time: { value: 1713150960 },
            num_stops: 12,
          },
        }],
      }],
    }],
  });

  const step = r.routes[0].steps[0];
  assertEqual(step.type, "bus", "transit step type is bus");
  assertEqual(step.line, "109", "line short name");
  assertEqual(step.lineFullName, "Ciudad Vieja - Cerro", "line full name");
  assertEqual(step.company, "Cutcsa", "company name trimmed (no comma suffix)");
  assertEqual(step.headsign, "Cerro", "headsign");
  assertEqual(step.departureStop, "Plaza Independencia", "departure stop");
  assertEqual(step.arrivalStop, "Terminal Cerro", "arrival stop");
  assertEqual(step.numStops, 12, "num stops");
  assertEqual(step.durationMin, 15, "15 min transit");
}

// Test 5: multiple routes (alternatives)
{
  const r = transformDirections({
    status: "OK",
    routes: [
      { summary: "A", overview_polyline: { points: "a" }, legs: [{ duration: { value: 600 }, distance: { value: 1000 }, steps: [] }] },
      { summary: "B", overview_polyline: { points: "b" }, legs: [{ duration: { value: 1200 }, distance: { value: 2000 }, steps: [] }] },
    ],
  });

  assertEqual(r.routes.length, 2, "two alternative routes");
  assertEqual(r.routes[0].totalDurationMin, 10, "first route 10 min");
  assertEqual(r.routes[1].totalDurationMin, 20, "second route 20 min");
}

// Test 6: route with no legs (shouldn't crash)
{
  const r = transformDirections({
    status: "OK",
    routes: [{ summary: "", overview_polyline: { points: "" }, legs: [] }],
  });
  assertEqual(r.routes.length, 0, "route with no legs filtered out");
}

// Test 7: missing optional fields
{
  const r = transformDirections({
    status: "OK",
    routes: [{
      legs: [{
        duration: { value: 300 },
        distance: { value: 1000 },
        steps: [{
          travel_mode: "TRANSIT",
          duration: { value: 300 },
          distance: { value: 1000 },
          polyline: { points: "" },
          transit_details: {
            line: { vehicle: { type: "BUS" } },
          },
        }],
      }],
    }],
  });

  const step = r.routes[0].steps[0];
  assertEqual(step.line, "", "missing line name defaults to empty");
  assertEqual(step.company, "", "missing agency defaults to empty");
  assertEqual(step.headsign, "", "missing headsign defaults to empty");
  assertEqual(step.numStops, 0, "missing numStops defaults to 0");
}

// ─── Results ─────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
