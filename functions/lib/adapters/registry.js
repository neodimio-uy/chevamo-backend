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
 *   - Si es JSON custom (Lisboa, GCBA Simple, etc.) → adapter dedicado en
 *     `lib/adapters/<feed>.js` con su Zod schema
 *
 * Mantenemos box sanitizador para feeds custom — confianza zero en lo que
 * viene del backend externo (puede cambiar shape sin avisar).
 */

const axios = require("axios");
const { transit_realtime } = require("gtfs-realtime-bindings");
const { XMLParser } = require("fast-xml-parser");
const gtfsRt = require("./gtfs-rt-generic");
const gcba = require("./gcba");
const cmLisboa = require("./cm-lisboa");
const immStm = require("./imm-stm");
const codesa = require("./codesa-avl");
const gtfsRtJson = require("./gtfs-rt-json");

const IMM_BASE = "https://api.montevideo.gub.uy/api/transportepublico";

// XML parser singleton para feeds AVL (CODESA y futuros). textNodeName
// permite leer el contenido de tags simples como `<lat>-34.92</lat>`.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

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
 * Carris Metropolitana Lisboa — `/v2/vehicles`. JSON enriquecido, sin auth.
 */
async function fetchCmLisboaVehicles({ ctx }) {
  const url = "https://api.carrismetropolitana.pt/v2/vehicles";
  const r = await axios.get(url, { timeout: 12_000, responseType: "json" });
  if (!Array.isArray(r.data)) {
    throw new Error("CM Lisboa response is not an array");
  }
  return cmLisboa.mapFeedToVehicles(r.data, ctx);
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
 * STM-online filtrado a empresas suburbanas (COPSA, CITA, CASANOVA, COIT,
 * SAN ANTONIO, ZEBALLOS HERMANOS, RUTAS DEL NORTE). 254+ buses live a hora
 * pico. Comparte la fuente con `imm-stm` pero con filtro distinto.
 */
async function fetchImmStmSuburbanVehicles({ fetchStmOnlineRaw, ctx }) {
  if (typeof fetchStmOnlineRaw !== "function") {
    throw new Error("imm-stm-suburban requires fetchStmOnlineRaw helper");
  }
  const stmRaw = await fetchStmOnlineRaw();
  if (!Array.isArray(stmRaw)) {
    throw new Error("stm-online returned non-array");
  }
  return immStm.mapSuburbanFeedToVehicles(stmRaw, ctx);
}

/**
 * CODESA Maldonado / Punta del Este — feed `avl.xml` Busmatick. URL pública
 * sin auth, CORS abierto. Refresh sugerido 15s.
 */
async function fetchCodesaAvl({ ctx }) {
  const url = `http://ip.codesa.com.uy/pub/avl.xml?noCache=${Date.now()}`;
  const r = await axios.get(url, {
    timeout: 12_000,
    responseType: "text",
    // El servidor Busmatick declara ISO-8859-1; axios + parser lo manejan
    headers: { Accept: "application/xml,text/xml" },
  });
  if (typeof r.data !== "string" || r.data.length === 0) {
    throw new Error("CODESA avl.xml empty response");
  }
  const parsed = xmlParser.parse(r.data);
  return codesa.mapFeedToVehicles(parsed, ctx);
}

/**
 * GTFS-Realtime en formato JSON (no protobuf). Algunos operadores como
 * Renfe publican el feed decodificado a JSON. `bbox` opcional filtra para
 * exponer un feed nacional como múltiples zonas locales.
 *
 * @param {object} opts
 * @param {string} opts.url - URL del feed JSON
 * @param {object} [opts.bbox] - { swLat, swLng, neLat, neLng }
 * @param {string} [opts.agencyName] - nombre de la operadora (Renfe, etc.)
 * @param {object} [opts.headers]
 * @param {object} opts.ctx
 */
async function fetchGtfsRtJsonVehicles({ url, bbox, agencyName, agencyId, headers = {}, ctx }) {
  const r = await axios.get(url, {
    timeout: 15_000,
    responseType: "json",
    headers,
  });
  const enrichedCtx = { ...ctx, bbox, agencyName, agencyId };
  return gtfsRtJson.mapFeedToVehicles(r.data, enrichedCtx);
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

    case "cm-lisboa-vehicles":
      return fetchCmLisboaVehicles({ ctx });

    case "imm-stm":
      return fetchImmStmVehicles({
        getImmToken:        secrets.getImmToken,
        fetchStmOnlineRaw:  secrets.fetchStmOnlineRaw,
        ctx,
      });

    case "imm-stm-suburban":
      // Suburbano UY (Canelones / San José / Costa de Oro): filtra el
      // mismo feed STM por empresas que operan líneas suburbanas. NO usa
      // IMM `/buses` autenticado (IMM suele filtrar a urbanas) — siempre
      // pega a stm-online que trae ambos sistemas y filtra acá.
      return fetchImmStmSuburbanVehicles({
        fetchStmOnlineRaw: secrets.fetchStmOnlineRaw,
        ctx,
      });

    case "transmilenio-positions":
      // GTFS-Realtime VehiclePositions estándar publicado por TransMilenio Bogotá.
      // Refresh cada 15s. URL pública sin auth.
      return fetchGtfsRtVehicles({
        url: "https://gtfs.transmilenio.gov.co/positions.pb",
        ctx,
      });

    case "codesa-avl":
      return fetchCodesaAvl({ ctx });

    case "renfe-largadistancia-json":
      // Renfe Larga Distancia GTFS-RT en formato JSON. Cobertura España
      // entera (lat 36-44, lng -9 a +4). Refresh ~10s (servidor sirve la
      // última snapshot). Sin auth, sin CORS limit (uso server-to-server).
      return fetchGtfsRtJsonVehicles({
        url: "https://gtfsrt.renfe.com/vehicle_positions_LD.json",
        agencyName: "Renfe",
        agencyId:   "renfe",
        ctx,
      });

    // ─────────────────────────────────────────────────────────────────────────
    // Tier 1 — feeds sin auth, GTFS-RT protobuf estándar (2026-04-27)
    // Confirmados con HEAD live: 200 + protobuf válido.
    // ─────────────────────────────────────────────────────────────────────────

    case "hsl-helsinki-vp":
      // HSL Helsingin seudun liikenne. Cubre Helsinki + 9 municipios area metro.
      // Bus + tram + metro + ferry + commuter rail. MQTT también disponible.
      return fetchGtfsRtVehicles({
        url: "https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl",
        ctx,
      });

    case "metrotransit-minneapolis-vp":
      // Metro Transit Twin Cities. Bus + light rail + commuter + BRT.
      return fetchGtfsRtVehicles({
        url: "https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb",
        ctx,
      });

    case "ovapi-netherlands-vp":
      // OVapi/NDOV agregador NACIONAL Holanda (NS + GVB + RET + HTM + Connexxion).
      // Endpoint vehiclePositions.pb (NO `tripUpdates.pb` que es shape distinto).
      // Bus + tram + metro + train + ferry. Cobertura toda Holanda.
      return fetchGtfsRtVehicles({
        url: "http://gtfs.ovapi.nl/nl/vehiclePositions.pb",
        ctx,
      });

    case "translink-brisbane-vp":
      // TransLink Queensland. Bus + train + ferry + light rail. SE Queensland.
      return fetchGtfsRtVehicles({
        url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
        ctx,
      });

    // ─────────────────────────────────────────────────────────────────────────
    // Tier 1 con problemas (postergados a investigación específica):
    //   - Budapest BKK: necesita apikey (reporte del agente fue incorrecto)
    //   - Denver RTD:   endpoint legacy deprecated 2025-12-05, hay nuevo API V2
    //   - Toronto TTC:  endpoint cambió post-NextRide migration 2024
    //   - Berlín VBB:   URL incorrecta, hay que buscar el path correcto
    // ─────────────────────────────────────────────────────────────────────────

    // Feeds GTFS-RT estándar adicionales (sumar URLs aquí cuando se confirmen):
    // case "tmb-barcelona-vp":
    //   return fetchGtfsRtVehicles({
    //     url: "https://api.tmb.cat/v1/...",
    //     headers: { "X-Api-Key": secrets.tmbKey },
    //     ctx,
    //   });

    // mtop-suburban / mtop-longdistance pendientes de migración (Milestone 2)
    case "mtop-suburban":
    case "mtop-longdistance":
      throw new Error(`Feed "${feedId}" usa adapter legacy en index.js (pendiente Milestone 2)`);

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
  fetchCmLisboaVehicles,
  fetchGtfsRtVehicles,
  fetchImmStmVehicles,
};
