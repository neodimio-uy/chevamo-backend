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

// Mapea cada service_id de calendar.txt a uno de: "WD" (weekday), "Sat",
// "Sun", o null (service raro que no aplica a ningún día estándar). El
// criterio es por mayoría de flags activos:
//   - service con monday-friday todos en 1 → WD
//   - service con saturday=1 y week=0     → Sat
//   - service con sunday=1 y resto=0      → Sun
// Services que combinen varios días (ej: "todos los días") se clasifican
// por el primer match. STM Montevideo emite tres services puros separados,
// así que esta clasificación es estable en la práctica.
function classifyService(row) {
  const wd = ["monday", "tuesday", "wednesday", "thursday", "friday"]
    .every(d => row[d] === "1");
  if (wd) return "WD";
  if (row.saturday === "1" && row.sunday !== "1") return "Sat";
  if (row.sunday === "1" && row.saturday !== "1") return "Sun";
  // Service mixto (raro): clasifica por el primer flag activo
  if (row.saturday === "1") return "Sat";
  if (row.sunday === "1") return "Sun";
  return null;
}

async function main() {
  console.log("Cargando routes...");
  const routes = await parseCSV("routes.txt");
  const routeMap = {};
  routes.forEach(r => routeMap[r.route_id] = r.route_short_name || r.route_long_name);

  console.log("Cargando calendar...");
  const calendar = await parseCSV("calendar.txt");
  const serviceMap = {}; // service_id → "WD" | "Sat" | "Sun"
  calendar.forEach(c => {
    const kind = classifyService(c);
    if (kind) serviceMap[c.service_id] = kind;
  });
  console.log(`Services clasificados: ${Object.keys(serviceMap).length} / ${calendar.length}`);

  console.log("Cargando trips...");
  const trips = await parseCSV("trips.txt");
  // tripId → { routeId, serviceKind } (serviceKind ya resuelto)
  const tripMap = {};
  trips.forEach(t => {
    const serviceKind = serviceMap[t.service_id];
    if (!serviceKind) return; // skip trips de services no clasificados
    tripMap[t.trip_id] = { routeId: t.route_id, serviceKind };
  });

  console.log("Procesando stop_times...");
  // stopSchedules[stopId][line][serviceKind] = [hora1, hora2, ...]
  // Estructura nueva (v2): un nivel más profundo por service. El handler
  // detecta el día actual y sirve solo la lista del service correspondiente.
  // Resuelve el bug de horarios mezclados WD/Sat/Sun.
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

    const tripInfo = tripMap[tripId];
    if (!tripInfo) continue;
    const lineName = routeMap[tripInfo.routeId];
    if (!lineName) continue;

    if (!stopSchedules[stopId]) stopSchedules[stopId] = {};
    if (!stopSchedules[stopId][lineName]) stopSchedules[stopId][lineName] = {};
    if (!stopSchedules[stopId][lineName][tripInfo.serviceKind]) {
      stopSchedules[stopId][lineName][tripInfo.serviceKind] = [];
    }
    stopSchedules[stopId][lineName][tripInfo.serviceKind].push(time);

    count++;
    if (count % 500000 === 0) console.log(`  ${count} filas...`);
  }

  // Ordenar + dedupe por serviceKind. El dedupe es por si dos trips del
  // mismo service tienen el mismo departure_time exacto (raro pero ocurre).
  Object.keys(stopSchedules).forEach(stopId => {
    Object.keys(stopSchedules[stopId]).forEach(line => {
      Object.keys(stopSchedules[stopId][line]).forEach(kind => {
        const sorted = [...new Set(stopSchedules[stopId][line][kind])].sort();
        stopSchedules[stopId][line][kind] = sorted;
      });
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
    Object.entries(ex).slice(0, 3).forEach(([line, byService]) => {
      const wd = (byService.WD || []).slice(0, 3).join(", ");
      const sat = (byService.Sat || []).slice(0, 3).join(", ");
      const sun = (byService.Sun || []).slice(0, 3).join(", ");
      console.log(`  Línea ${line}:`);
      console.log(`    WD : ${wd}...`);
      console.log(`    Sat: ${sat}...`);
      console.log(`    Sun: ${sun}...`);
    });
  }
}

main().catch(console.error);
