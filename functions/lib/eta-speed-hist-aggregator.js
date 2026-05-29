/**
 * Agregador BQ→Firestore de la velocidad histórica por `línea × franja horaria`
 * (`v_hist`) — palanca #1 del Smart ETA v2 (ver chevamo-docs/eta/).
 *
 * Lo registra `index.js` como `onSchedule` (`aggregateLineSpeedHist`). Computa
 * desde `bus_positions` la velocidad media DERIVADA DE GPS
 * (`distFromPrevM/secsSincePrev`), NO el campo de velocidad de la IMM (poco
 * confiable punto-a-punto: corr 0.29 vs GPS, ~16% ceros, ~9% reporta "0" con el
 * bus moviéndose). El promedio histórico converge igual (corr 0.94 bucket-level),
 * pero lo construimos de la fuente defendible.
 *
 * Output: doc `system/eta_speed_by_line_hour` con `{ buckets: {"line|hourBand": kmh} }`,
 * consumido por `eta-speed-hist.js`. Idempotente: si la query falla o no hay
 * rows, NO sobrescribe el doc anterior.
 *
 * Costo: ~14 días de scan de bus_positions (cols mínimas) / 6h ≈ centavos/mes.
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { logger } = require("firebase-functions");

const BQ_PROJECT = process.env.GCLOUD_PROJECT || "vamo-dbad6";
const BQ_DATASET = process.env.BQ_TELEMETRY_DATASET || "vamo_telemetry";
const BQ_LOCATION = process.env.BQ_TELEMETRY_LOCATION || "southamerica-east1";

const WINDOW_DAYS = 14;
const MIN_OBS_PER_BUCKET = 30;
const SPEED_BOUNDS = [5, 50]; // mismo clamp físico que eta-speed-hist.js

let bqClient = null;
function getBqClient() {
  if (bqClient) return bqClient;
  bqClient = new BigQuery({ projectId: BQ_PROJECT });
  return bqClient;
}

function clampSpeed(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(Math.max(v, SPEED_BOUNDS[0]), SPEED_BOUNDS[1]);
}

function buildQuery({ windowDays = WINDOW_DAYS, minObs = MIN_OBS_PER_BUCKET } = {}) {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  return `
WITH pos AS (
  SELECT
    line,
    uyHourBand AS hourBand,
    SAFE_DIVIDE(distFromPrevM, NULLIF(secsSincePrev, 0)) * 3.6 AS v_gps
  FROM ${ds}.bus_positions
  WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowDays} DAY)
    AND secsSincePrev BETWEEN 20 AND 180
    AND distFromPrevM IS NOT NULL
    AND line IS NOT NULL
    AND uyHourBand IS NOT NULL
)
SELECT line, hourBand, AVG(v_gps) AS speed_kmh, COUNT(*) AS observations
FROM pos
WHERE v_gps BETWEEN 0 AND 80
GROUP BY line, hourBand
HAVING observations >= ${minObs}
ORDER BY observations DESC
LIMIT 5000
`.trim();
}

async function runQuery(opts) {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildQuery(opts),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/** Filas BQ → `{ "line|hourBand": speedKmh }` (formato que lee eta-speed-hist). */
function bucketsFromRows(rows) {
  const buckets = {};
  for (const row of rows) {
    const line = String(row.line || "").trim();
    if (!line) continue;
    const hourBand = Number(row.hourBand);
    if (!Number.isFinite(hourBand)) continue;
    const speed = clampSpeed(Number(row.speed_kmh));
    if (speed == null) continue;
    buckets[`${line}|${hourBand}`] = Number(speed.toFixed(2));
  }
  return buckets;
}

/** Función principal — la registra `index.js` como `onSchedule`. Idempotente. */
async function runAndPersist({ admin } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  const startMs = Date.now();
  let rows;
  try {
    rows = await runQuery();
  } catch (e) {
    logger.error(`aggregateLineSpeedHist: query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info("aggregateLineSpeedHist: no rows in window (doc anterior intacto)");
    return { ok: true, bucketCount: 0, skipped: "no rows" };
  }
  const buckets = bucketsFromRows(rows);
  const observationsConsidered = rows.reduce((a, r) => a + (Number(r.observations) || 0), 0);
  await admin
    .firestore()
    .collection("system")
    .doc("eta_speed_by_line_hour")
    .set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      windowDays: WINDOW_DAYS,
      observationsConsidered,
      bucketCount: Object.keys(buckets).length,
      buckets,
      source: "bq-gps-scheduled",
      computedInMs: Date.now() - startMs,
    });
  logger.info(
    `aggregateLineSpeedHist: ${Object.keys(buckets).length} buckets desde ${rows.length} rows (${observationsConsidered} obs)`
  );
  return { ok: true, bucketCount: Object.keys(buckets).length, observationsConsidered };
}

module.exports = {
  WINDOW_DAYS,
  MIN_OBS_PER_BUCKET,
  SPEED_BOUNDS,
  buildQuery,
  bucketsFromRows,
  runAndPersist,
  clampSpeed,
};
