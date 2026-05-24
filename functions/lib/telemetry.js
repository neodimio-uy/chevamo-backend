/**
 * Telemetry hub Fase A (transport-side) — consolidado para todos los topics.
 *
 * Patrón: 1 topic Pub/Sub por tabla BigQuery, subscription Pub/Sub→BQ con
 * `--use-table-schema`. Cada `publish*` es fire-and-forget — el publish no
 * se awaitea para no agregar latencia al handler/cron que lo dispara. Si
 * el env var del topic correspondiente no está seteado, la publicación es
 * no-op (permite deployar el código sin activar el sink).
 *
 * Topics + tablas BQ:
 *   ETA_TELEMETRY_TOPIC        → vamo_telemetry.eta_requests
 *   POSITIONS_TELEMETRY_TOPIC  → vamo_telemetry.bus_positions
 *   ARRIVALS_TELEMETRY_TOPIC   → vamo_telemetry.bus_arrivals
 *
 * Sampling: `TELEMETRY_SAMPLE_RATE` (default 1.0) baja el % de events
 * publicados a través del board. Útil si el volumen escala a otras
 * ciudades y queremos limitar costo. Eta tiene su propio `ETA_TELEMETRY_SAMPLE_RATE`
 * que toma precedencia (compat con la versión vieja del módulo).
 *
 * Diseño hilos: los publishers son singletons por topicName, instanciados
 * lazy. Las llamadas de publish son thread-safe (Pub/Sub client maneja
 * concurrencia internamente).
 */

const { PubSub } = require("@google-cloud/pubsub");
const { logger } = require("firebase-functions");

const DEFAULT_SAMPLE_RATE = parseFloat(
  process.env.TELEMETRY_SAMPLE_RATE || "1.0"
);

let pubsubClient = null;
const publisherCache = new Map();

function getPubSubClient() {
  if (pubsubClient) return pubsubClient;
  try {
    pubsubClient = new PubSub();
    return pubsubClient;
  } catch (e) {
    logger.warn(`telemetry: PubSub client init failed: ${e.message}`);
    return null;
  }
}

function getPublisher(topicName) {
  if (!topicName) return null;
  if (publisherCache.has(topicName)) return publisherCache.get(topicName);
  const client = getPubSubClient();
  if (!client) return null;
  try {
    const publisher = client.topic(topicName, {
      batching: {
        // Acumular hasta 50 mensajes o 100ms — bueno para bus_positions
        // que dispara ~400 publishes back-to-back por cron tick.
        maxMessages: 50,
        maxMilliseconds: 100,
      },
    });
    publisherCache.set(topicName, publisher);
    return publisher;
  } catch (e) {
    logger.warn(`telemetry: topic ${topicName} init failed: ${e.message}`);
    return null;
  }
}

function publishToTopic(topicName, payload, sampleRate = DEFAULT_SAMPLE_RATE) {
  const publisher = getPublisher(topicName);
  if (!publisher) return;
  if (sampleRate < 1.0 && Math.random() > sampleRate) return;

  try {
    const data = Buffer.from(JSON.stringify(payload));
    publisher.publishMessage({ data }).catch((err) => {
      if (Math.random() < 0.01) {
        logger.warn(`telemetry: ${topicName} publish failed: ${err.message}`);
      }
    });
  } catch (e) {
    if (Math.random() < 0.01) {
      logger.warn(`telemetry: ${topicName} serialize failed: ${e.message}`);
    }
  }
}

// ─── eta_requests ──────────────────────────────────────────────────────
// Compat: re-export del módulo viejo para no romper imports en index.js.
// El `publish` viejo lee `ETA_TELEMETRY_TOPIC` directo del env, mantiene
// su propio publisher cacheado. Acá NO duplicamos esa lógica — index.js
// sigue importando `lib/eta-telemetry` para el flow ETA.

// ─── bus_positions ─────────────────────────────────────────────────────

/**
 * Publica un snapshot de posición de un bus.
 *
 * @param {object} bus - bus mapeado al schema canónico (ver mapImmStmBus)
 * @param {object} ctx - { now: Date, etaCtx?: ETAContext, prevObs?: { ts, lat, lng } }
 */
function publishBusPosition(bus, ctx) {
  const topic = process.env.POSITIONS_TELEMETRY_TOPIC;
  if (!topic) return;
  const payload = buildPositionEvent(bus, ctx);
  if (!payload) return;
  publishToTopic(topic, payload);
}

function buildPositionEvent(bus, ctx = {}) {
  const now = ctx.now || new Date();
  const coords = bus?.position;
  if (!coords || typeof coords.lat !== "number" || typeof coords.lng !== "number") {
    return null;
  }

  let feedTs = null;
  let stalenessSec = null;
  if (typeof bus.timestamp === "number") {
    feedTs = new Date(bus.timestamp * 1000);
    stalenessSec = Math.max(0, Math.round((now.getTime() - feedTs.getTime()) / 1000));
  }

  let distFromPrevM = null;
  let secsSincePrev = null;
  if (ctx.prevObs && typeof ctx.prevObs.lat === "number") {
    distFromPrevM = haversineMeters(coords.lat, coords.lng, ctx.prevObs.lat, ctx.prevObs.lng);
    if (ctx.prevObs.ts) {
      secsSincePrev = Math.max(0, Math.round((now.getTime() - ctx.prevObs.ts) / 1000));
    }
  }

  return {
    ts: now.toISOString(),
    busId: String(bus.id || bus.busId || ""),
    line: String(bus.trip?.routeShortName || bus.trip?.routeId || bus.line || ""),
    lineVariantId: bus.trip?.tripId ? String(bus.trip.tripId) : null,
    destination: bus.trip?.headsign || null,
    origin: bus.trip?.origin || null,
    company: bus.agency?.name || bus.trip?.agencyName || bus.company || null,
    lat: coords.lat,
    lng: coords.lng,
    speedKmh: typeof coords.speed === "number" ? coords.speed : null,
    feedTs: feedTs ? feedTs.toISOString() : null,
    stalenessSec,
    distFromPrevM,
    secsSincePrev,
    uyHour: ctx.etaCtx ? ctx.etaCtx.uyHour(now) : null,
    uyHourBand: ctx.etaCtx ? ctx.etaCtx.hourToBand(ctx.etaCtx.uyHour(now)) : null,
    uyDayKind: ctx.etaCtx ? ctx.etaCtx.dayKind(now) : null,
    source: "imm",
  };
}

// ─── bus_arrivals ──────────────────────────────────────────────────────

function publishBusArrival(event) {
  const topic = process.env.ARRIVALS_TELEMETRY_TOPIC;
  if (!topic) return;
  if (!event || !event.busId || !event.stopId || !event.eventType) return;
  publishToTopic(topic, event);
}

/**
 * @param {object} args
 * @param {Date} args.now
 * @param {object} args.bus - bus en formato canónico
 * @param {object} args.stop - { stopId, stopName, lat, lng }
 * @param {"arrived"|"departed"} args.eventType
 * @param {number} args.distM
 * @param {object} [args.windowState] - solo para 'departed': { firstSeenTs, minDistM }
 * @param {object} [args.etaCtx]
 */
function buildArrivalEvent({
  now,
  bus,
  stop,
  eventType,
  distM,
  windowState,
  etaCtx,
}) {
  const ts = now || new Date();
  const coords = bus?.position || {};
  let dwellSec = null;
  let minDistInWindowM = null;
  if (eventType === "departed" && windowState) {
    if (windowState.firstSeenTs) {
      dwellSec = Math.max(0, Math.round((ts.getTime() - windowState.firstSeenTs) / 1000));
    }
    if (typeof windowState.minDistM === "number") {
      minDistInWindowM = windowState.minDistM;
    }
  }
  return {
    ts: ts.toISOString(),
    busId: String(bus.id || bus.busId || ""),
    line: String(bus.trip?.routeShortName || bus.trip?.routeId || bus.line || ""),
    lineVariantId: bus.trip?.tripId ? String(bus.trip.tripId) : null,
    destination: bus.trip?.headsign || null,
    company: bus.agency?.name || bus.trip?.agencyName || bus.company || null,
    stopId: String(stop.stopId),
    stopName: stop.name || stop.stopName || null,
    eventType,
    distM: typeof distM === "number" ? distM : null,
    minDistInWindowM,
    speedKmh: typeof coords.speed === "number" ? coords.speed : null,
    dwellSec,
    lat: typeof coords.lat === "number" ? coords.lat : null,
    lng: typeof coords.lng === "number" ? coords.lng : null,
    uyHour: etaCtx ? etaCtx.uyHour(ts) : null,
    uyHourBand: etaCtx ? etaCtx.hourToBand(etaCtx.uyHour(ts)) : null,
    uyDayKind: etaCtx ? etaCtx.dayKind(ts) : null,
    source: "imm-proximity",
  };
}

// ─── utils ─────────────────────────────────────────────────────────────

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function stats() {
  return {
    eta: !!process.env.ETA_TELEMETRY_TOPIC,
    positions: !!process.env.POSITIONS_TELEMETRY_TOPIC,
    arrivals: !!process.env.ARRIVALS_TELEMETRY_TOPIC,
    sampleRate: DEFAULT_SAMPLE_RATE,
  };
}

module.exports = {
  publishBusPosition,
  buildPositionEvent,
  publishBusArrival,
  buildArrivalEvent,
  haversineMeters,
  publishToTopic,
  stats,
};
