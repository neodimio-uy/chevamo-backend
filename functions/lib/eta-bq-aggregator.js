/**
 * Agregador BQ-side de factores de calibración del ETA — Sprint Unif 19.
 *
 * Coexiste con `aggregateEtaFactors` (Firestore-driven, lee
 * `eta_observations`). Este corre la MISMA función pero con data del
 * Telemetry Hub Fase A (BigQuery), que tiene más fidelidad:
 *
 *   - `eta_requests`: cada call a /upcoming con etaRaw + etaFinalSec por bus
 *   - `bus_arrivals`: detector de proximidad (cuándo un bus efectivamente
 *     llegó a la parada)
 *
 * Joinea ambas para tener (predicted_sec, actual_sec) por (busId, stopId)
 * y agrega factor = AVG(actual_sec / predicted_sec) por bucket
 * (line × hourBand × dayKind). El factor se aplica como multiplicador
 * en eta-fusion: etaFinal = etaPred × factor.
 *
 * Output: doc `system/eta_calibration_factors_bq` (NUEVO, separado del
 * doc Firestore para que coexistan A/B). El lookup en
 * `eta-calibrator-lookup.js` prueba BQ primero; si no hay match en
 * ninguno de los 3 niveles cascada, fallback al doc Firestore existente.
 * Source stamp: `bq:exact` | `bq:parent` | `bq:grandpa` | `firestore:exact` | ...
 *
 * Window: 14 días (mismo que aggregator Firestore). Cap mínimo de obs
 * por bucket: 8 (ligeramente más estricto que el Firestore para
 * compensar mayor volumen total de la fuente BQ).
 *
 * Costo: 1 query / 6h × 14 días de scan ≈ ~50MB scanned / query →
 * <$0.01/mes. Despreciable.
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { logger } = require("firebase-functions");

const BQ_PROJECT = process.env.GCLOUD_PROJECT || "vamo-dbad6";
const BQ_DATASET = process.env.BQ_TELEMETRY_DATASET || "vamo_telemetry";
const BQ_LOCATION = process.env.BQ_TELEMETRY_LOCATION || "southamerica-east1";

const WINDOW_DAYS = 14;
const MIN_OBS_PER_BUCKET = 8;
const FACTOR_BOUNDS = [0.6, 1.5];

// Mismo set de bandas que ETAContext (cliente y server consistentes).
// hourToBand: 0=madrugada(0-5), 1=mañana(6-9), 2=mediodía(10-14),
// 3=tarde(15-19), 4=noche(20-23). bucketKey usa hourBand directo.

let bqClient = null;
function getBqClient() {
  if (bqClient) return bqClient;
  bqClient = new BigQuery({ projectId: BQ_PROJECT });
  return bqClient;
}

function clampFactor(f) {
  if (!Number.isFinite(f) || f <= 0) return 1.0;
  return Math.min(Math.max(f, FACTOR_BOUNDS[0]), FACTOR_BOUNDS[1]);
}

/**
 * Construye la query SQL canónica. Parametrizable por window/min-obs
 * para tests y para ajustes futuros sin redeploy.
 */
function buildQuery({ windowDays = WINDOW_DAYS, minObs = MIN_OBS_PER_BUCKET } = {}) {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  return `
WITH predictions AS (
  SELECT
    r.ts AS request_ts,
    r.stopId,
    r.uyHourBand AS hourBand,
    r.uyDayKind  AS dayKind,
    b.busId,
    -- Match key Unif 21+: canonical busUid si está presente, sino
    -- fallback al hack legacy CONCAT('imm-stm:', busId) para compat
    -- con data anterior al rollout busUid (~2026-05-25). Después de
    -- ~14 días de data nueva podemos eliminar el fallback.
    COALESCE(b.busUid, CONCAT('imm-stm:', b.busId)) AS match_key,
    b.line,
    b.etaRaw AS predicted_sec
  FROM ${ds}.eta_requests r,
       UNNEST(r.buses) AS b
  WHERE r.ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowDays} DAY)
    AND b.etaRaw IS NOT NULL
    AND b.etaRaw BETWEEN 60 AND 1800
    AND b.busId IS NOT NULL AND b.busId != ''
    AND r.uyHourBand IS NOT NULL
    AND r.uyDayKind IS NOT NULL
    AND b.line IS NOT NULL AND b.line != ''
),
arrivals AS (
  SELECT
    busId,
    -- Mismo fallback: busUid (nuevo) o busId legacy con prefijo.
    COALESCE(busUid, busId) AS match_key,
    stopId,
    ts AS actual_arrival_ts
  FROM ${ds}.bus_arrivals
  WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowDays} DAY)
    AND eventType = 'arrived'
),
matched AS (
  SELECT
    p.line,
    p.hourBand,
    p.dayKind,
    p.predicted_sec,
    TIMESTAMP_DIFF(a.actual_arrival_ts, p.request_ts, SECOND) AS actual_sec
  FROM predictions p
  JOIN arrivals a
    -- JOIN por canonical busUid (con fallback backward-compat).
    -- Pre-Unif 21 esto era CONCAT('imm-stm:', busId) — pero los busId
    -- colisionan cross-empresa (CUTCSA #63 ≠ COETC #63), por lo que
    -- ese JOIN matcheaba arrivals de OTRAS empresas y contaminaba la
    -- calibración. busUid incluye company y resuelve la colisión.
    ON p.match_key = a.match_key
    AND p.stopId = a.stopId
    AND a.actual_arrival_ts > p.request_ts
    AND a.actual_arrival_ts < TIMESTAMP_ADD(p.request_ts, INTERVAL 30 MINUTE)
  -- Tomar el arrival más cercano post-request por (match_key, stopId, request_ts).
  -- Sin esto, si un bus arriva 2 veces (variantes que solapan), contamos doble.
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY p.request_ts, p.match_key, p.stopId
    ORDER BY a.actual_arrival_ts
  ) = 1
)
SELECT
  line,
  hourBand,
  dayKind,
  COUNT(*) AS observations,
  AVG(SAFE_DIVIDE(actual_sec, predicted_sec)) AS factor_raw,
  -- Percentiles para diagnostics (no usados en output, útil en logs)
  APPROX_QUANTILES(SAFE_DIVIDE(actual_sec, predicted_sec), 10)[OFFSET(5)] AS factor_p50
FROM matched
WHERE actual_sec BETWEEN 60 AND 1800
  AND SAFE_DIVIDE(actual_sec, predicted_sec) BETWEEN 0.2 AND 5
GROUP BY line, hourBand, dayKind
HAVING observations >= ${minObs}
ORDER BY observations DESC
LIMIT 5000
`.trim();
}

/**
 * Ejecuta la query en BigQuery y devuelve filas crudas.
 */
async function runQuery(opts) {
  const bq = getBqClient();
  const query = buildQuery(opts);
  const [job] = await bq.createQueryJob({
    query,
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/**
 * Convierte las filas BQ al formato `{ key: factor }` compatible con
 * el lookup. Keys son `line|hourBand|dayKind|none|none` (sin rain ni
 * severity por ahora — BQ no tiene esas features expuestas en
 * `eta_requests` todavía; cuando se agreguen al payload telemetry,
 * podemos sub-particionar acá).
 */
function bucketsFromRows(rows) {
  const factors = {};
  for (const row of rows) {
    const line = String(row.line || "").trim();
    if (!line) continue;
    const hourBand = Number(row.hourBand);
    if (!Number.isFinite(hourBand)) continue;
    const dayKind = String(row.dayKind || "").trim();
    if (!dayKind) continue;
    const factor = clampFactor(Number(row.factor_raw));
    const key = `${line}|${hourBand}|${dayKind}|none|none`;
    factors[key] = factor;
  }
  return factors;
}

/**
 * Función principal — la registra `index.js` como `onSchedule`.
 * Idempotente: si no hay rows o falla la query, no escribe sobre
 * el doc anterior (para no romper el lookup A/B).
 */
async function runAndPersist({ admin } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  const startMs = Date.now();
  let rows;
  try {
    rows = await runQuery();
  } catch (e) {
    logger.error(`aggregateEtaFactorsFromBq: query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info("aggregateEtaFactorsFromBq: no matched observations in window");
    // Mantenemos el doc anterior (no sobreescribimos con vacío) — si
    // el feed se queda corto temporalmente no queremos que el lookup
    // pierda los buckets ya calculados.
    return { ok: true, bucketCount: 0, skipped: "no rows" };
  }
  const buckets = bucketsFromRows(rows);
  const observationsConsidered = rows.reduce(
    (acc, r) => acc + (Number(r.observations) || 0),
    0
  );
  await admin
    .firestore()
    .collection("system")
    .doc("eta_calibration_factors_bq")
    .set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      windowDays: WINDOW_DAYS,
      observationsConsidered,
      bucketCount: Object.keys(buckets).length,
      buckets,
      source: "bq-scheduled",
      computedInMs: Date.now() - startMs,
    });
  logger.info(
    `aggregateEtaFactorsFromBq: ${Object.keys(buckets).length} buckets desde ${rows.length} rows (${observationsConsidered} obs)`
  );
  return {
    ok: true,
    bucketCount: Object.keys(buckets).length,
    observationsConsidered,
    computedInMs: Date.now() - startMs,
  };
}

module.exports = {
  FACTOR_BOUNDS,
  WINDOW_DAYS,
  MIN_OBS_PER_BUCKET,
  buildQuery,
  bucketsFromRows,
  runAndPersist,
  clampFactor,
};
