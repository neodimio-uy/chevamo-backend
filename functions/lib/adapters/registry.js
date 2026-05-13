/**
 * Registry de adapters de feeds de transporte por (cityId, mode, service).
 *
 * Patrón: cada feed source registra una función `fetchVehicles(ctx)` que:
 *   1. Hace fetch al backend externo (con auth si requiere)
 *   2. Pasa la respuesta por su box sanitizador Zod
 *   3. Mapea al schema canónico VehicleSchema
 *   4. Devuelve `{ vehicles, feedTimestamp, ... }`
 *
 * Sumar feed nuevo:
 *   - Si es GTFS-RT estándar protobuf → usar `gtfs-rt-generic.js`, basta agregar
 *     URL + auth en este archivo
 *   - Si es JSON custom (GCBA Simple, etc.) → adapter dedicado en
 *     `lib/adapters/<feed>.js` con su Zod schema
 *
 * Mantenemos box sanitizador para feeds custom — confianza zero en lo que
 * viene del backend externo (puede cambiar shape sin avisar).
 */

const axios = require("axios");
const gtfsRt = require("./gtfs-rt-generic");
const gcba = require("./gcba");
const immStm = require("./imm-stm");

const IMM_BASE = "https://api.montevideo.gub.uy/api/transportepublico";

// ─────────────────────────────────────────────────────────────────────────────
// Adapter implementations por feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GCBA `/colectivos/vehiclePositionsSimple` — JSON enriquecido, AMBA AR.
 *
 * Auth: client_id + client_secret en query string (Secret Manager).
 *
 * @param {object} opts
 * @param {string} opts.clientId - BA_TRANSPORT_CLIENT_ID
 * @param {string} opts.clientSecret - BA_TRANSPORT_CLIENT_SECRET
 * @param {object} opts.ctx - { cityId, mode, feedSource }
 */
async function fetchGcbaVehiclesSimple({ clientId, clientSecret, ctx }) {
  if (!clientId || !clientSecret) {
    throw new Error("GCBA credentials not configured");
  }
  const url = `https://apitransporte.buenosaires.gob.ar/colectivos/vehiclePositionsSimple?client_id=${clientId}&client_secret=${clientSecret}`;
  const r = await axios.get(url, { timeout: 12_000, responseType: "json" });
  if (!Array.isArray(r.data)) {
    throw new Error("GCBA response is not an array");
  }
  return gcba.mapFeedToVehicles(r.data, ctx);
}

/**
 * IMM/STM Montevideo — `/buses` autenticado con OAuth + fallback stm-online.
 *
 * Recibe `getImmToken` (función bound al cache de tokens del index.js) para
 * compartir el token entre `/buses` legacy y `/vehicles?country=UY...`. Si
 * IMM falla, intenta stm-online vía `fetchStmOnlineRaw` (también bound desde
 * index.js para reusar `EMPRESA_NAMES` y la normalización a shape `BusSchema`).
 *
 * @param {object} opts
 * @param {() => Promise<string>} opts.getImmToken
 * @param {() => Promise<Array>} opts.fetchStmOnlineRaw
 * @param {object} opts.ctx
 */
async function fetchImmStmVehicles({ getImmToken, fetchStmOnlineRaw, ctx }) {
  if (typeof getImmToken !== "function" || typeof fetchStmOnlineRaw !== "function") {
    throw new Error("imm-stm adapter requires getImmToken + fetchStmOnlineRaw helpers");
  }

  // Primary: IMM API autenticado
  try {
    const token = await getImmToken();
    const r = await axios.get(`${IMM_BASE}/buses`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    if (!Array.isArray(r.data)) {
      throw new Error("IMM /buses response is not an array");
    }
    return immStm.mapFeedToVehicles(r.data, ctx);
  } catch (primaryErr) {
    // Fallback: stm-online (sin auth, normalizado al shape BusSchema)
    try {
      const stmRaw = await fetchStmOnlineRaw();
      if (!Array.isArray(stmRaw) || stmRaw.length === 0) {
        throw new Error("stm-online fallback returned empty");
      }
      return immStm.mapFeedToVehicles(stmRaw, ctx);
    } catch (fallbackErr) {
      // Re-lanzar el error primary (más informativo de la falla raíz)
      const e = new Error(`imm-stm primary failed (${primaryErr.message}) and stm-online fallback failed (${fallbackErr.message})`);
      e.cause = primaryErr;
      throw e;
    }
  }
}

/**
 * GTFS-RT genérico vía URL — protobuf binario.
 *
 * @param {object} opts
 * @param {string} opts.url - URL completa del feed
 * @param {object} [opts.headers] - headers HTTP (auth si requiere)
 * @param {object} opts.ctx
 */
async function fetchGtfsRtVehicles({ url, headers = {}, ctx }) {
  const r = await axios.get(url, {
    timeout: 12_000,
    responseType: "arraybuffer",
    headers,
  });
  return gtfsRt.mapFeedToVehicles(r.data, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch principal: dado el `feed` ID del CityConfig, llama al adapter
 * correspondiente con sus opciones.
 *
 * @param {string} feedId - ID del feed en CityConfig.modes[mode].feed
 * @param {object} ctx - { cityId, mode, feedSource } (feedSource = feedId)
 * @param {object} secrets - secretos del environment (Cloud Functions defineSecret)
 */
async function dispatch(feedId, ctx, secrets = {}) {
  switch (feedId) {
    case "gcba-vehicles-simple":
      return fetchGcbaVehiclesSimple({
        clientId: secrets.baTransportClientId,
        clientSecret: secrets.baTransportClientSecret,
        ctx,
      });

    case "imm-stm":
      return fetchImmStmVehicles({
        getImmToken:        secrets.getImmToken,
        fetchStmOnlineRaw:  secrets.fetchStmOnlineRaw,
        ctx,
      });

    case "gcba-subte-forecast":
    case "gcba-ecobici-gbfs":
      throw new Error(`Feed "${feedId}" pendiente de implementación en registry`);

    default:
      throw new Error(`Feed desconocido: "${feedId}"`);
  }
}

module.exports = {
  dispatch,
  // exports para testing directo:
  fetchGcbaVehiclesSimple,
  fetchGtfsRtVehicles,
  fetchImmStmVehicles,
};
