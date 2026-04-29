const fs = require("fs");
const path = require("path");
const readline = require("readline");

const gtfsDir = path.join(__dirname, "gtfs");

async function parseCSV(file) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(gtfsDir, file)),
    crlfDelay: Infinity
  });
  let headers = null;
  for await (const line of rl) {
    if (!headers) { headers = line.split(",").map(h => h.trim().replace(/"/g,"")); continue; }
    const vals = line.split(",").map(v => v.trim().replace(/"/g,""));
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || "");
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log("Procesando routes...");
  const routes = await parseCSV("routes.txt");
  console.log("Rutas:", routes.length);
  console.log("Ejemplo:", JSON.stringify(routes[0]));

  console.log("\nProcesando trips...");
  const trips = await parseCSV("trips.txt");
  console.log("Viajes:", trips.length);
  console.log("Ejemplo:", JSON.stringify(trips[0]));

  console.log("\nProcesando stops...");
  const stops = await parseCSV("stops.txt");
  console.log("Paradas:", stops.length);
  console.log("Ejemplo:", JSON.stringify(stops[0]));

  // Mapa routeId → línea
  const routeMap = {};
  routes.forEach(r => routeMap[r.route_id] = r.route_short_name || r.route_long_name);

  // Mapa tripId → routeId
  const tripMap = {};
  trips.forEach(t => tripMap[t.trip_id] = t.route_id);

  // Procesar stop_times — construir stopId → Set de líneas
  console.log("\nProcesando stop_times (esto tarda)...");
  const stopLines = {};
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(gtfsDir, "stop_times.txt")),
    crlfDelay: Infinity
  });
  let headers = null;
  let count = 0;
  for await (const line of rl) {
    if (!headers) { headers = line.split(",").map(h => h.trim().replace(/"/g,"")); continue; }
    const vals = line.split(",");
    const tripId = vals[headers.indexOf("trip_id")]?.trim().replace(/"/g,"");
    const stopId = vals[headers.indexOf("stop_id")]?.trim().replace(/"/g,"");
    if (!tripId || !stopId) continue;
    const routeId = tripMap[tripId];
    if (!routeId) continue;
    const lineName = routeMap[routeId];
    if (!lineName) continue;
    if (!stopLines[stopId]) stopLines[stopId] = new Set();
    stopLines[stopId].add(lineName);
    count++;
    if (count % 500000 === 0) console.log(`  Procesadas ${count} filas...`);
  }

  // Convertir Sets a arrays y guardar
  const result = {};
  Object.keys(stopLines).forEach(k => result[k] = [...stopLines[k]].sort());

  const outPath = path.join(__dirname, "stop-lines.json");
  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(`\n✅ stop-lines.json guardado`);
  console.log(`   Paradas con líneas: ${Object.keys(result).length}`);

  // Muestra ejemplo
  const sample = Object.entries(result).slice(0, 3);
  sample.forEach(([stop, lines]) => console.log(`   Parada ${stop}: ${lines.join(", ")}`));
}

main().catch(console.error);
