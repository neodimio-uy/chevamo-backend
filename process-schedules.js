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
    if (!headers) {
      headers = line.split(",").map(h => h.trim().replace(/"/g, ""));
      continue;
    }
    const vals = line.split(",").map(v => v.trim().replace(/"/g, ""));
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || "");
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log("Cargando routes...");
  const routes = await parseCSV("routes.txt");
  const routeMap = {};
  routes.forEach(r => routeMap[r.route_id] = r.route_short_name || r.route_long_name);

  console.log("Cargando trips...");
  const trips = await parseCSV("trips.txt");
  const tripMap = {};
  trips.forEach(t => tripMap[t.trip_id] = t.route_id);

  console.log("Procesando stop_times...");
  // stopSchedules[stopId][line] = [hora1, hora2, ...]
  const stopSchedules = {};
  
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(gtfsDir, "stop_times.txt")),
    crlfDelay: Infinity
  });
  
  let headers = null;
  let count = 0;
  
  for await (const line of rl) {
    if (!headers) {
      headers = line.split(",").map(h => h.trim().replace(/"/g, ""));
      continue;
    }
    const vals = line.split(",");
    const tripId  = vals[headers.indexOf("trip_id")]?.trim().replace(/"/g, "");
    const stopId  = vals[headers.indexOf("stop_id")]?.trim().replace(/"/g, "");
    const time    = vals[headers.indexOf("departure_time")]?.trim().replace(/"/g, "");
    
    if (!tripId || !stopId || !time) continue;
    
    const routeId  = tripMap[tripId];
    if (!routeId) continue;
    const lineName = routeMap[routeId];
    if (!lineName) continue;

    if (!stopSchedules[stopId]) stopSchedules[stopId] = {};
    if (!stopSchedules[stopId][lineName]) stopSchedules[stopId][lineName] = [];
    stopSchedules[stopId][lineName].push(time);
    
    count++;
    if (count % 500000 === 0) console.log(`  ${count} filas...`);
  }

  // Ordenar horarios
  Object.keys(stopSchedules).forEach(stopId => {
    Object.keys(stopSchedules[stopId]).forEach(line => {
      stopSchedules[stopId][line].sort();
    });
  });

  const outPath = path.join(__dirname, "stop-schedules.json");
  fs.writeFileSync(outPath, JSON.stringify(stopSchedules));
  
  const size = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n✅ stop-schedules.json — ${size}KB`);
  console.log(`   Paradas: ${Object.keys(stopSchedules).length}`);
  
  // Ejemplo parada 570
  const ex = stopSchedules["570"];
  if (ex) {
    console.log("\nEjemplo parada 570:");
    Object.entries(ex).slice(0, 3).forEach(([line, times]) => {
      console.log(`  Línea ${line}: ${times.slice(0, 5).join(", ")}...`);
    });
  }
}

main().catch(console.error);
