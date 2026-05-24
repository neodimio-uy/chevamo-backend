/**
 * Catálogo de shapes (recorridos geométricos) de líneas Mvd.
 *
 * Source: `gtfs/shapes.txt` empacado con el deploy. Formato GTFS estándar:
 *   shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence
 *
 * `shape_id` mapea 1:1 con `lineVariantId` del feed IMM (ver
 * `lib/schemas/lineVariant.js`). Eso permite ir directo desde un bus
 * a su recorrido: `bus.lineVariantId → /shapes/:shapeId → points`.
 *
 * Diseño:
 * - Lazy-load al primer acceso (~13MB en memoria, ~329k puntos).
 * - Single-flight pattern: si llega un segundo request mientras el
 *   primero carga, espera el promise existente.
 * - Sin TTL: el GTFS estático cambia con el pipeline mensual; cold
 *   start regenera.
 * - Points en formato compact `[lat, lng]` (no objeto) para ahorrar
 *   bytes al serializar.
 */

const path = require("path");
const fs = require("fs/promises");
const { logger } = require("firebase-functions");

// shapes.txt vive en functions/ (copia del GTFS estático). Se incluye en
// el bundle del deploy, igual que stop-schedules.json. Si el pipeline GTFS
// actualiza el shape, hay que copiarlo de nuevo: cp gtfs/shapes.txt functions/.
const SHAPES_PATH = path.join(__dirname, "..", "shapes.txt");

let shapesById = null;
let inflightPromise = null;

async function ensureLoaded() {
  if (shapesById) return shapesById;
  if (inflightPromise) return inflightPromise;

  inflightPromise = (async () => {
    const t0 = Date.now();
    try {
      const raw = await fs.readFile(SHAPES_PATH, "utf-8");
      const lines = raw.split("\n");
      // Header: shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
      const map = new Map();
      let parsed = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const cols = line.split(",");
        if (cols.length < 4) continue;
        const shapeId = cols[0];
        const lat = parseFloat(cols[1]);
        const lng = parseFloat(cols[2]);
        const seq = parseInt(cols[3], 10);
        if (!shapeId || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(seq)) continue;
        if (!map.has(shapeId)) map.set(shapeId, []);
        map.get(shapeId).push([seq, lat, lng]);
        parsed++;
      }
      // Sort by sequence + drop seq (only [lat,lng] remain) para que
      // el frontend pueda dibujarlos sin sort adicional.
      for (const [shapeId, points] of map.entries()) {
        points.sort((a, b) => a[0] - b[0]);
        map.set(shapeId, points.map((p) => [p[1], p[2]]));
      }
      shapesById = map;
      const ms = Date.now() - t0;
      logger.info(`shapes-catalog: ${map.size} shapes (${parsed} puntos) en ${ms}ms`);
      return map;
    } catch (e) {
      logger.error(`shapes-catalog load failed: ${e.message}`);
      throw e;
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

async function getShape(shapeId) {
  await ensureLoaded();
  return shapesById.get(String(shapeId)) || null;
}

function stats() {
  return {
    loaded: !!shapesById,
    shapes: shapesById ? shapesById.size : 0,
  };
}

module.exports = { ensureLoaded, getShape, stats };
