#!/usr/bin/env node
/**
 * Pre-procesa gtfs/trips.txt + gtfs/stop_times.txt → functions/shape-stops.json
 *
 * Output shape:
 *   { "<shape_id>": ["<stopId>", "<stopId>", ...] }
 *
 * Para cada shape_id, tomamos UN trip (asumimos que todos los trips
 * con el mismo shape tienen idéntica secuencia de stops) y emitimos
 * los stops ordenados por stop_sequence.
 *
 * Resultado esperado: ~10x más chico que stop_times.txt original (84MB → ~5-8MB)
 * porque eliminamos timestamps + dedupeamos shapes.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = __dirname;
const TRIPS_PATH = path.join(ROOT, "gtfs", "trips.txt");
const STOP_TIMES_PATH = path.join(ROOT, "gtfs", "stop_times.txt");
const OUTPUT_PATH = path.join(ROOT, "functions", "shape-stops.json");

async function parseCsvLine(line) {
  // Naive: GTFS no usa quoted fields con comas internas para trips.txt /
  // stop_times.txt (lo verifiqué con head). Si en el futuro hay comas
  // escapadas dentro de strings, hay que pasar a un CSV parser.
  return line.split(",");
}

async function main() {
  console.log(`Leyendo trips.txt → trip_id → shape_id`);
  const tripIdToShape = new Map(); // trip_id → shape_id
  const tripIdHeader = {};
  {
    const rl = readline.createInterface({ input: fs.createReadStream(TRIPS_PATH) });
    let firstLine = true;
    for await (const line of rl) {
      if (firstLine) {
        const cols = await parseCsvLine(line);
        cols.forEach((c, i) => { tripIdHeader[c.trim()] = i; });
        firstLine = false;
        continue;
      }
      const cols = await parseCsvLine(line);
      if (cols.length < 3) continue;
      const tripId = cols[tripIdHeader.trip_id];
      const shapeId = cols[tripIdHeader.shape_id];
      if (tripId && shapeId) tripIdToShape.set(tripId, shapeId);
    }
  }
  console.log(`  → ${tripIdToShape.size} trips con shape_id`);

  // Para no procesar todos los trips de cada shape, elegimos el PRIMER
  // trip que vemos de cada shape. Los demás trips se ignoran (asumimos
  // misma secuencia de stops para un shape dado).
  const shapeToFirstTrip = new Map(); // shape_id → trip_id
  for (const [tripId, shapeId] of tripIdToShape) {
    if (!shapeToFirstTrip.has(shapeId)) {
      shapeToFirstTrip.set(shapeId, tripId);
    }
  }
  const repTripIds = new Set(shapeToFirstTrip.values());
  console.log(`  → ${shapeToFirstTrip.size} shapes únicos`);

  console.log(`Leyendo stop_times.txt streaming (solo trips representativos)`);
  // shape_id → [{ stopId, seq }]  durante parse, sort y reduce al final
  const tripToStops = new Map(); // trip_id → [{ stopId, seq }]
  const stHeader = {};
  let processedRows = 0;
  {
    const rl = readline.createInterface({ input: fs.createReadStream(STOP_TIMES_PATH) });
    let firstLine = true;
    for await (const line of rl) {
      if (firstLine) {
        const cols = await parseCsvLine(line);
        cols.forEach((c, i) => { stHeader[c.trim()] = i; });
        firstLine = false;
        continue;
      }
      const cols = await parseCsvLine(line);
      if (cols.length < 5) continue;
      const tripId = cols[stHeader.trip_id];
      if (!repTripIds.has(tripId)) continue; // skip non-representative
      const stopId = cols[stHeader.stop_id];
      const seq = parseInt(cols[stHeader.stop_sequence], 10);
      if (!stopId || !Number.isFinite(seq)) continue;
      if (!tripToStops.has(tripId)) tripToStops.set(tripId, []);
      tripToStops.get(tripId).push({ stopId, seq });
      processedRows++;
      if (processedRows % 200000 === 0) {
        process.stdout.write(`  ${processedRows} rows…\r`);
      }
    }
  }
  console.log(`\n  → ${processedRows} stop_times rows asignadas a ${tripToStops.size} trips`);

  console.log(`Building shape → stops map`);
  const shapeStops = {};
  for (const [shapeId, tripId] of shapeToFirstTrip) {
    const stops = tripToStops.get(tripId);
    if (!stops || stops.length === 0) continue;
    stops.sort((a, b) => a.seq - b.seq);
    shapeStops[shapeId] = stops.map((s) => s.stopId);
  }
  console.log(`  → ${Object.keys(shapeStops).length} shapes con stops`);

  const json = JSON.stringify(shapeStops);
  fs.writeFileSync(OUTPUT_PATH, json);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT_PATH} (${sizeMB} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
