/**
 * Lookup server-side de factores de calibración del ETA.
 *
 * Lee el doc `system/eta_calibration_factors` que escribe el cron
 * `aggregateEtaFactors` cada 6h. Aplica la misma cascada que el cliente
 * iOS (`ETACalibrator.factor(for:)`):
 *
 *   1. Bucket exacto (line, hourBand, dayKind, rainIntensity, incidentSeverity)
 *   2. Bucket padre (line + hourBand + dayKind, rain/incident → "none")
 *   3. Bucket grandpa (line solo, hourBand=-1, dayKind="any", resto "none")
 *   4. Factor 1.0 (sin calibrar)
 *
 * **Importante:** este módulo NO replica la lógica de COMPUTAR factores
 * (cron `aggregateEtaFactors` lo hace). Solo es lookup. La fuente de
 * verdad de los factores es Firestore.
 *
 * **Cache:** el doc completo se cachea in-memory TTL 5min. El cron corre
 * cada 6h → 5min de stale máximo es trivial. Sin Firestore listener
 * porque cada lookup en el hot path no debe gatillar IO.
 */

const FACTORS_DOC = "eta_calibration_factors";
const FACTORS_COL = "system";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const FACTOR_BOUNDS = [0.6, 1.5];

let cachedBuckets = null;       // { [key]: factor }
let cachedAt = 0;               // ms
let cachedMeta = null;          // { observationsConsidered, users, bucketCount, updatedAt }
let inflightPromise = null;     // dedupe concurrent fetches

/**
 * Obtiene el map de buckets desde Firestore (con cache). Si Firestore
 * falla o el doc no existe, devuelve `{}` — el lookup cae a factor 1.0
 * en todos los casos. Nunca lanza.
 */
async function getBucketsFromFirestore(admin) {
  const now = Date.now();
  if (cachedBuckets && now - cachedAt < CACHE_TTL_MS) {
    return cachedBuckets;
  }
  if (inflightPromise) return inflightPromise;

  inflightPromise = (async () => {
    try {
      const doc = await admin.firestore()
        .collection(FACTORS_COL)
        .doc(FACTORS_DOC)
        .get();
      if (!doc.exists) {
        cachedBuckets = {};
      } else {
        const data = doc.data() || {};
        cachedBuckets = (data.buckets && typeof data.buckets === "object")
          ? data.buckets
          : {};
        cachedMeta = {
          observationsConsidered: data.observationsConsidered || 0,
          users: data.users || 0,
          bucketCount: data.bucketCount || Object.keys(cachedBuckets).length,
          updatedAt: data.updatedAt?.toMillis?.() || null,
        };
      }
      cachedAt = Date.now();
      return cachedBuckets;
    } catch (e) {
      // Silencioso: cualquier fallo deja `factor = 1.0` en todos los lookups.
      // No queremos que un blip de Firestore tire la fusion.
      cachedBuckets = cachedBuckets || {};
      cachedAt = Date.now(); // evita reintento inmediato
      return cachedBuckets;
    } finally {
      inflightPromise = null;
    }
  })();
  return inflightPromise;
}

function clampFactor(f) {
  if (!Number.isFinite(f) || f <= 0) return 1.0;
  return Math.min(Math.max(f, FACTOR_BOUNDS[0]), FACTOR_BOUNDS[1]);
}

/**
 * Construye una key de bucket compatible con el esquema que escribe el cron.
 * Formato: `${line}|${hourBand}|${dayKind}|${rainIntensity}|${incidentSeverity}`
 */
function bucketKey({ line, hourBand, dayKind, rainIntensity = "none", incidentSeverity = "none" }) {
  return `${line}|${hourBand}|${dayKind}|${rainIntensity}|${incidentSeverity}`;
}

/**
 * Cascada de lookup. Devuelve factor en [0.6, 1.5] o 1.0 si nada matchea.
 *
 * @param {object} bucket — { line, hourBand, dayKind, rainIntensity, incidentSeverity }
 * @param {object} buckets — map de Firestore { key: factor }
 */
function lookupFactor(bucket, buckets) {
  if (!buckets || typeof buckets !== "object") return 1.0;

  // 1) Exacto
  const exact = bucketKey(bucket);
  if (typeof buckets[exact] === "number") return clampFactor(buckets[exact]);

  // 2) Padre (mismo line+hourBand+dayKind, sin rain ni incident)
  const parent = bucketKey({
    line: bucket.line,
    hourBand: bucket.hourBand,
    dayKind: bucket.dayKind,
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[parent] === "number") return clampFactor(buckets[parent]);

  // 3) Grandpa (line solo, banda -1, dayKind "any")
  const grandpa = bucketKey({
    line: bucket.line,
    hourBand: -1,
    dayKind: "any",
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[grandpa] === "number") return clampFactor(buckets[grandpa]);

  return 1.0;
}

/**
 * API de alto nivel: obtiene factores de Firestore (cacheado) y aplica
 * cascada. Devuelve `{ factor, source }`. `source` ayuda a observability:
 *   - "exact" | "parent" | "grandpa" | "none"
 */
async function factor({ bucket, admin }) {
  const buckets = await getBucketsFromFirestore(admin);

  // Repite el lookup pero también reporta qué nivel matcheó.
  const exact = bucketKey(bucket);
  if (typeof buckets[exact] === "number") {
    return { factor: clampFactor(buckets[exact]), source: "exact" };
  }
  const parent = bucketKey({
    line: bucket.line,
    hourBand: bucket.hourBand,
    dayKind: bucket.dayKind,
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[parent] === "number") {
    return { factor: clampFactor(buckets[parent]), source: "parent" };
  }
  const grandpa = bucketKey({
    line: bucket.line,
    hourBand: -1,
    dayKind: "any",
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[grandpa] === "number") {
    return { factor: clampFactor(buckets[grandpa]), source: "grandpa" };
  }
  return { factor: 1.0, source: "none" };
}

/** Para tests y diagnostics. */
function _resetCache() {
  cachedBuckets = null;
  cachedAt = 0;
  cachedMeta = null;
  inflightPromise = null;
}

function stats() {
  return {
    cachedAt: cachedAt > 0 ? new Date(cachedAt).toISOString() : null,
    cachedAgeMs: cachedAt > 0 ? Date.now() - cachedAt : null,
    bucketsLoaded: cachedBuckets ? Object.keys(cachedBuckets).length : 0,
    meta: cachedMeta,
  };
}

module.exports = {
  FACTOR_BOUNDS,
  CACHE_TTL_MS,
  bucketKey,
  lookupFactor,
  factor,
  stats,
  _resetCache,
};
