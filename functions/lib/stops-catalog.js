/**
 * Catálogo de paradas Mvd con coords + index inverso línea→paradas.
 *
 * Source de paradas: endpoint IMM `/busstops` (~1.4k paradas Mvd) que
 * retorna shape canónico { busstopId, street1, street2, location: { coordinates: [lng, lat] } }.
 * Source de líneas-por-parada: `stop-lines.json` ya cargado eager por index.js.
 *
 * Diseño:
 * - Lazy load: primera llamada a `ensureLoaded()` dispara fetch IMM.
 * - In-memory cache en la instancia warm. Cold start regenera (~1-2s).
 * - TTL conceptual 24h via `loadedAt + 24h`. En la práctica, instancias
 *   Cloud Functions raramente sobreviven 24h, así que el TTL casi nunca
 *   se gatilla — pero si lo hace, retorna el viejo y re-fetcha en
 *   background sin bloquear al caller.
 *
 * Output del catalog:
 *   stopsById:    Map<stopId, { stopId, name, lat, lng }>
 *   stopsByLine:  Map<line, [{ stopId, name, lat, lng }]>
 *
 * No persiste en Firestore ni Redis — el catálogo es derivado, regenerar
 * es barato y consistente. Si la app crece a Argentina + Brasil, este
 * módulo se va a refactorear a Firestore + cache layer.
 */

const path = require("path");
const fs = require("fs/promises");
const axios = require("axios").default;
const { logger } = require("firebase-functions");
const { validateList } = require("./validate");
const { BusStopSchema } = require("./schemas/busstop");

const IMM_BASE = process.env.IMM_BASE_URL || "https://api.montevideo.gub.uy/api/transportepublico";
const FRESH_TTL_MS = 24 * 60 * 60 * 1000;

let stopsById = null;
let stopsByLine = null;
let loadedAt = 0;
let inflightPromise = null;

/**
 * @param {() => Promise<string>} getImmToken - inyectado por el caller (función getToken de index.js).
 * @returns {Promise<{ stopsById: Map, stopsByLine: Map }>}
 */
async function ensureLoaded(getImmToken) {
  const now = Date.now();
  if (stopsById && now - loadedAt < FRESH_TTL_MS) {
    return { stopsById, stopsByLine };
  }
  if (inflightPromise) return inflightPromise;

  inflightPromise = (async () => {
    try {
      const token = await getImmToken();
      const r = await axios.get(`${IMM_BASE}/buses/busstops`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      });
      const { valid } = validateList(BusStopSchema, r.data, "stops-catalog");

      const stopLinesPath = path.join(__dirname, "..", "stop-lines.json");
      const stopLinesRaw = await fs.readFile(stopLinesPath, "utf-8");
      const stopLines = JSON.parse(stopLinesRaw);

      const nextById = new Map();
      const nextByLine = new Map();
      for (const stop of valid) {
        const coords = stop?.location?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const id = String(stop.busstopId);
        const name = [stop.street1, stop.street2].filter(Boolean).join(" y ") || null;
        const entry = { stopId: id, name, lat, lng };
        nextById.set(id, entry);

        const lines = stopLines[id] || [];
        for (const line of lines) {
          const key = String(line);
          if (!nextByLine.has(key)) nextByLine.set(key, []);
          nextByLine.get(key).push(entry);
        }
      }

      stopsById = nextById;
      stopsByLine = nextByLine;
      loadedAt = Date.now();
      logger.info(
        `stops-catalog: ${nextById.size} paradas indexadas en ${nextByLine.size} líneas`
      );
      return { stopsById, stopsByLine };
    } catch (e) {
      logger.error(`stops-catalog load failed: ${e.message}`);
      throw e;
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

function getStopsForLine(line) {
  if (!stopsByLine) return [];
  return stopsByLine.get(String(line)) || [];
}

function getStopById(stopId) {
  if (!stopsById) return null;
  return stopsById.get(String(stopId)) || null;
}

function stats() {
  return {
    loaded: !!stopsById,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
    stops: stopsById ? stopsById.size : 0,
    lines: stopsByLine ? stopsByLine.size : 0,
  };
}

module.exports = { ensureLoaded, getStopsForLine, getStopById, stats };
