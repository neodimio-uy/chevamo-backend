/**
 * Catálogo `shape_id → [stop_ids ordenados]`.
 *
 * Pre-generado por `process-shape-stops.js` desde `gtfs/trips.txt +
 * gtfs/stop_times.txt`. Output: `functions/shape-stops.json` (~0.4 MB).
 *
 * Caso de uso principal: cuando el user clickea un bus, el cliente
 * tiene `bus.lineVariantId` (== shape_id). Para mostrar las paradas
 * EXACTAS del recorrido (no todas las de la línea en cualquier variante),
 * pega `/variants/:shapeId/stops` y junta con su catalog de stops para
 * obtener coords + nombres.
 *
 * Lazy-load module-level: el JSON se carga la primera vez que se llama
 * `getStopsForShape()`. Cold start agrega ~30-50ms de I/O sync.
 */

const path = require("path");
const fs = require("fs");
const { logger } = require("firebase-functions");

const JSON_PATH = path.join(__dirname, "..", "shape-stops.json");

let shapeToStops = null;
let loadedAt = 0;

function ensureLoaded() {
  if (shapeToStops) return shapeToStops;
  const t0 = Date.now();
  const raw = fs.readFileSync(JSON_PATH, "utf-8");
  shapeToStops = JSON.parse(raw);
  loadedAt = Date.now();
  logger.info(`variants-catalog: ${Object.keys(shapeToStops).length} shapes loaded en ${Date.now() - t0}ms`);
  return shapeToStops;
}

function getStopsForShape(shapeId) {
  ensureLoaded();
  return shapeToStops[String(shapeId)] || null;
}

function stats() {
  return {
    loaded: !!shapeToStops,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
    shapes: shapeToStops ? Object.keys(shapeToStops).length : 0,
  };
}

module.exports = { getStopsForShape, stats };
