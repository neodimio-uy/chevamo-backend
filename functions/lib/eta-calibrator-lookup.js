/**
 * Lookup server-side de factores de calibración del ETA.
 *
 * **Sprint Unif 19 (A/B safe):** ahora hay DOS fuentes de factores
 * coexistiendo. La cascada es:
 *
 *   1-3. BQ-derived  (doc `system/eta_calibration_factors_bq`)
 *        → bucket exacto → padre → grandpa
 *   4-6. Firestore-derived (doc `system/eta_calibration_factors`)
 *        → bucket exacto → padre → grandpa
 *   7.   Factor 1.0 (sin calibrar)
 *
 * Source stamp para telemetry: `bq:exact` | `bq:parent` | `bq:grandpa`
 * | `firestore:exact` | `firestore:parent` | `firestore:grandpa` | `none`.
 * Esto permite comparar accuracy A/B en Looker.
 *
 * El BQ-derived es escrito por `aggregateEtaFactorsFromBq` (cada 6h, fuente
 * Telemetry Hub Fase A con JOIN eta_requests↔bus_arrivals). El Firestore-
 * derived sigue siendo escrito por `aggregateEtaFactors` (fuente Firestore
 * `eta_observations` desde clientes iOS). Cuando los factors BQ se validen
 * en producción (1-2 meses), se descomisará el aggregator Firestore y
 * este lookup colapsa a una sola fuente.
 *
 * **Cache:** ambos docs se cachean in-memory TTL 5min separadamente.
 */

const FACTORS_DOC_FIRESTORE = "eta_calibration_factors";
const FACTORS_DOC_BQ = "eta_calibration_factors_bq";
const FACTORS_COL = "system";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const FACTOR_BOUNDS = [0.6, 1.5];

// Caches separados por source. Misma estrategia: dedupe in-flight,
// silencioso si Firestore falla.
const caches = {
  firestore: { buckets: null, at: 0, meta: null, inflight: null },
  bq:        { buckets: null, at: 0, meta: null, inflight: null },
};

async function getBucketsFor(source, admin) {
  const docName = source === "bq" ? FACTORS_DOC_BQ : FACTORS_DOC_FIRESTORE;
  const cache = caches[source];
  const now = Date.now();
  if (cache.buckets && now - cache.at < CACHE_TTL_MS) return cache.buckets;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const doc = await admin.firestore().collection(FACTORS_COL).doc(docName).get();
      if (!doc.exists) {
        cache.buckets = {};
        cache.meta = null;
      } else {
        const data = doc.data() || {};
        cache.buckets = (data.buckets && typeof data.buckets === "object")
          ? data.buckets
          : {};
        cache.meta = {
          observationsConsidered: data.observationsConsidered || 0,
          users: data.users || 0,
          bucketCount: data.bucketCount || Object.keys(cache.buckets).length,
          updatedAt: data.updatedAt?.toMillis?.() || null,
          docSource: data.source || null,
        };
      }
      cache.at = Date.now();
      return cache.buckets;
    } catch (e) {
      // Silencioso: cualquier fallo deja la cascada caer al próximo nivel.
      // No queremos que un blip de Firestore tire la fusion.
      cache.buckets = cache.buckets || {};
      cache.at = Date.now(); // evita reintento inmediato
      return cache.buckets;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

function clampFactor(f) {
  if (!Number.isFinite(f) || f <= 0) return 1.0;
  return Math.min(Math.max(f, FACTOR_BOUNDS[0]), FACTOR_BOUNDS[1]);
}

/**
 * Key de bucket. Formato: `${line}|${hourBand}|${dayKind}|${rain}|${severity}`.
 * El aggregator BQ no tiene rain/severity (todavía) → siempre escribe
 * "none|none". El Firestore sí los puebla cuando hay observation con
 * data de clima/incidente.
 */
function bucketKey({ line, hourBand, dayKind, rainIntensity = "none", incidentSeverity = "none" }) {
  return `${line}|${hourBand}|${dayKind}|${rainIntensity}|${incidentSeverity}`;
}

/**
 * Cascada de 3 niveles dentro de un map de buckets. Devuelve
 * `{ factor, level }` donde level = "exact" | "parent" | "grandpa" | null.
 */
function lookupInBuckets(bucket, buckets) {
  if (!buckets || typeof buckets !== "object") return { factor: null, level: null };
  const exact = bucketKey(bucket);
  if (typeof buckets[exact] === "number") {
    return { factor: clampFactor(buckets[exact]), level: "exact" };
  }
  const parent = bucketKey({
    line: bucket.line,
    hourBand: bucket.hourBand,
    dayKind: bucket.dayKind,
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[parent] === "number") {
    return { factor: clampFactor(buckets[parent]), level: "parent" };
  }
  const grandpa = bucketKey({
    line: bucket.line,
    hourBand: -1,
    dayKind: "any",
    rainIntensity: "none",
    incidentSeverity: "none",
  });
  if (typeof buckets[grandpa] === "number") {
    return { factor: clampFactor(buckets[grandpa]), level: "grandpa" };
  }
  return { factor: null, level: null };
}

/**
 * Compat: API legacy del lookup, usado por tests / call sites antiguos.
 * Solo consulta el map Firestore (default). Para A/B usar `factor()`.
 */
function lookupFactor(bucket, buckets) {
  const r = lookupInBuckets(bucket, buckets);
  return r.factor != null ? r.factor : 1.0;
}

/**
 * API de alto nivel — A/B safe. Prueba BQ first, después Firestore.
 * `source` reporta el origen efectivo del factor:
 *   "bq:exact" | "bq:parent" | "bq:grandpa"
 *   | "firestore:exact" | "firestore:parent" | "firestore:grandpa"
 *   | "none"
 */
async function factor({ bucket, admin }) {
  // 1-3. BQ-derived
  const bqBuckets = await getBucketsFor("bq", admin);
  const bqHit = lookupInBuckets(bucket, bqBuckets);
  if (bqHit.factor != null) {
    return { factor: bqHit.factor, source: `bq:${bqHit.level}` };
  }
  // 4-6. Firestore-derived fallback
  const fsBuckets = await getBucketsFor("firestore", admin);
  const fsHit = lookupInBuckets(bucket, fsBuckets);
  if (fsHit.factor != null) {
    return { factor: fsHit.factor, source: `firestore:${fsHit.level}` };
  }
  return { factor: 1.0, source: "none" };
}

/** Para tests y diagnostics. */
function _resetCache() {
  caches.firestore = { buckets: null, at: 0, meta: null, inflight: null };
  caches.bq        = { buckets: null, at: 0, meta: null, inflight: null };
}

function stats() {
  const dump = (key) => {
    const c = caches[key];
    return {
      cachedAt: c.at > 0 ? new Date(c.at).toISOString() : null,
      cachedAgeMs: c.at > 0 ? Date.now() - c.at : null,
      bucketsLoaded: c.buckets ? Object.keys(c.buckets).length : 0,
      meta: c.meta,
    };
  };
  return {
    firestore: dump("firestore"),
    bq: dump("bq"),
  };
}

module.exports = {
  FACTOR_BOUNDS,
  CACHE_TTL_MS,
  bucketKey,
  lookupFactor,
  lookupInBuckets,
  factor,
  stats,
  _resetCache,
};
