/**
 * Telemetry sink del Sprint 0 ETA. Publica cada request a `/upcoming`
 * (con su breakdown completo del cálculo) a un topic Pub/Sub. De ahí
 * se mueve a BigQuery via subscription nativo BQ — cero código de
 * routing.
 *
 * **Objetivo:** acumular dataset para entrenar modelos ML que predigan
 * ETA mejor que la fórmula manual. Esquema thinking-ahead pero NO over-
 * engineered: cada request = 1 row con todo lo que el modelo va a
 * necesitar como features + el output actual (etaFinal) como label
 * weak supervision. Cuando matcheemos contra arribos reales (tabla
 * `eta_actuals` futura), entrenamos contra label fuerte.
 *
 * **Fire-and-forget:** la publicación es async pero NO se awaitea — el
 * handler responde al cliente sin esperar el ack del topic. Si la
 * publicación falla, se loggea silencioso (no debe romper el endpoint).
 *
 * **Toggle:** controlado por env var `ETA_TELEMETRY_TOPIC`. Si no
 * está seteado, `publish()` es no-op. Permite deployar el código sin
 * activar el sink hasta tener el topic + BQ sink configurados en GCP.
 *
 * **Sampling:** por defecto 100% (todos los requests). Si el volumen
 * crece a millones/día, bajar via `ETA_TELEMETRY_SAMPLE_RATE=0.1` (10%).
 *
 * **Setup GCP (una vez):**
 *   gcloud pubsub topics create eta-telemetry
 *   bq --location=southamerica-east1 mk --dataset \
 *     vamo-dbad6:vamo_telemetry
 *   bq mk --table vamo-dbad6:vamo_telemetry.eta_requests \
 *     ./schemas/eta_requests.json
 *   gcloud pubsub subscriptions create eta-telemetry-bq-sink \
 *     --topic=eta-telemetry \
 *     --bigquery-table=vamo-dbad6:vamo_telemetry.eta_requests \
 *     --use-table-schema
 *   gcloud functions deploy api --update-env-vars \
 *     ETA_TELEMETRY_TOPIC=eta-telemetry
 *
 * **Costo estimado tu volumen (Mvd):**
 *   ~50k requests/día × ~1KB cada = 50MB/día → $0.04/mes Pub/Sub
 *   + BigQuery streaming ~$0.50/mes
 *   Total < $1/mes hasta escala Argentina/Brasil.
 */

const { PubSub } = require("@google-cloud/pubsub");
const { logger } = require("firebase-functions");
const { computeBusUid } = require("./bus-uid");

const TOPIC_NAME = process.env.ETA_TELEMETRY_TOPIC || null;
const SAMPLE_RATE = parseFloat(process.env.ETA_TELEMETRY_SAMPLE_RATE || "1.0");

let pubsubClient = null;
let topicPublisher = null;

function getTopicPublisher() {
  if (!TOPIC_NAME) return null;
  if (topicPublisher) return topicPublisher;
  try {
    pubsubClient = pubsubClient || new PubSub();
    topicPublisher = pubsubClient.topic(TOPIC_NAME, {
      // Batching reduce número de calls a Pub/Sub. Trade-off: latencia
      // hasta 100ms para acumular o 10 mensajes, lo que llegue primero.
      batching: {
        maxMessages: 10,
        maxMilliseconds: 100,
      },
    });
    return topicPublisher;
  } catch (e) {
    logger.warn(`eta-telemetry init failed: ${e.message}`);
    return null;
  }
}

/**
 * Publica un evento de telemetry. Fire-and-forget — no se awaitea el ack.
 *
 * El payload debe ser razonablemente plano. Pub/Sub serializa a JSON.
 * BigQuery sink toma cada campo top-level como columna. Si necesitamos
 * arrays/structs, usar REPEATED RECORD en el schema BQ.
 *
 * @param {object} payload — datos a loggear. Ver schema sugerido abajo.
 */
function publish(payload) {
  const publisher = getTopicPublisher();
  if (!publisher) return;
  if (Math.random() > SAMPLE_RATE) return;

  try {
    const data = Buffer.from(JSON.stringify(payload));
    // .catch() para que un fail no se vuelva unhandled rejection que
    // crashea la instancia.
    publisher.publishMessage({ data }).catch((err) => {
      // Sample log para no inundar si el topic está mal configurado.
      if (Math.random() < 0.01) {
        logger.warn(`eta-telemetry publish failed: ${err.message}`);
      }
    });
  } catch (e) {
    if (Math.random() < 0.01) {
      logger.warn(`eta-telemetry serialize failed: ${e.message}`);
    }
  }
}

/**
 * Helper para construir el payload canónico de un request a /upcoming
 * desde los inputs/outputs del handler. Centraliza el shape — si
 * agregamos campos al schema BQ, este es el único lugar a tocar.
 *
 * **Schema BQ esperado** (crear tabla con):
 *   ts                  TIMESTAMP
 *   stopId              STRING
 *   path                STRING       -- "/busstops/:id/upcoming"
 *   wantsTraffic        BOOL
 *   compareMode         BOOL
 *   hasAppCheckToken    BOOL
 *   hasIdToken          BOOL
 *   uid                 STRING       -- nullable
 *   pipelineSource      STRING       -- "imm+traffic+fusion" etc.
 *   busCount            INT64
 *   uyHour              INT64
 *   uyHourBand          INT64
 *   uyDayKind           STRING
 *   buses               REPEATED RECORD (busId, line, etaRaw,
 *                       googleEtaSec, etaFinalSec, etaSource,
 *                       etaConfidence, lat, lng, speedKmh,
 *                       calibFactor, calibSource, trafficFactor)
 */
function buildRequestEvent({
  stopId,
  path,
  wantsTraffic,
  compareMode,
  req,
  processed,
  pipelineSource,
  now = new Date(),
  ctx,
}) {
  const buses = (Array.isArray(processed) ? processed : []).map((bus) => {
    const coords = bus?.location?.coordinates;
    const lng = Array.isArray(coords) ? coords[0] : null;
    const lat = Array.isArray(coords) ? coords[1] : null;
    const tel = bus._etaTelemetry || {};
    return {
      busId: String(bus.busId || bus.id || bus.code || ""),
      // Canonical busUid (cross-empresa). Ver lib/bus-uid.js.
      busUid: bus.busUid || computeBusUid(bus),
      line: String(bus.line || ""),
      etaRaw: typeof bus.eta === "number" ? bus.eta : null,
      googleEtaSec: typeof bus.googleEtaSec === "number" ? bus.googleEtaSec : null,
      etaFinalSec: typeof bus.etaFinalSec === "number" ? bus.etaFinalSec : null,
      etaSource: bus.etaSource || null,
      etaConfidence: typeof bus.etaConfidence === "number" ? bus.etaConfidence : null,
      lat: typeof lat === "number" ? lat : null,
      lng: typeof lng === "number" ? lng : null,
      speedKmh: typeof bus.speedKmh === "number" ? bus.speedKmh : null,
      calibFactor: typeof tel.calibFactor === "number" ? tel.calibFactor : null,
      calibSource: tel.calibSource || null,
      trafficFactor: typeof tel.trafficFactor === "number" ? tel.trafficFactor : null,
    };
  });

  return {
    ts: now.toISOString(),
    stopId: String(stopId),
    path,
    wantsTraffic: !!wantsTraffic,
    compareMode: !!compareMode,
    hasAppCheckToken: !!req?.appCheck?.appId,
    hasIdToken: !!req?.auth?.uid,
    uid: req?.auth?.uid || null,
    pipelineSource: pipelineSource || null,
    busCount: buses.length,
    uyHour: ctx ? ctx.uyHour(now) : null,
    uyHourBand: ctx ? ctx.hourToBand(ctx.uyHour(now)) : null,
    uyDayKind: ctx ? ctx.dayKind(now) : null,
    buses,
  };
}

/** Stats útiles para /admin/diagnostics. */
function stats() {
  return {
    topic: TOPIC_NAME,
    sampleRate: SAMPLE_RATE,
    enabled: !!TOPIC_NAME,
  };
}

module.exports = {
  publish,
  buildRequestEvent,
  stats,
  TOPIC_NAME,
  SAMPLE_RATE,
};
