/**
 * Lookup server-side de la velocidad histórica por `línea × franja horaria`
 * (`v_hist`) — palanca #1 del Smart ETA v2 (ver chevamo-docs/eta/).
 *
 * **Por qué existe:** medido sobre el banco eta_eval (21.75M pares, holdout
 * temporal real), usar la velocidad media histórica de la línea a esa hora como
 * base del ETA le gana a la velocidad reciente del propio bus (`v_avg5`) en
 * MAE (~-47%) y en aciertos ±1min (+6 a +11 pp por banda). Es barato (un AVG
 * agrupado precomputable) y robusto.
 *
 * **Fuente de velocidad (importante):** se computa desde la velocidad
 * DERIVADA DE GPS (`distFromPrevM/secsSincePrev`), NO desde el campo de
 * velocidad que reporta la IMM. La velocidad IMM es poco confiable punto-a-punto
 * (corr 0.29 vs GPS, 16% ceros, ~9% "0 km/h" cuando el bus se mueve >10). El
 * promedio histórico igual converge (corr 0.94 entre ambas fuentes a nivel
 * bucket), pero construimos de la fuente defendible.
 *
 * El doc `system/eta_speed_by_line_hour` lo escribe el cron `aggregateLineSpeedHist`
 * (BQ → Firestore). Si el doc no existe, este lookup degrada a la velocidad
 * media global medida (DEFAULT_SPEED_KMH) — nunca rompe.
 *
 * **Cache:** in-memory TTL 6h con dedupe in-flight (mismo patrón que el
 * calibrator lookup). Silencioso ante fallos de Firestore.
 */

const SPEED_DOC = "eta_speed_by_line_hour";
const SPEED_COL = "system";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h (el cron actualiza cada 6-24h)

/** Velocidad media urbana de Montevideo medida (km/h, GPS-derivada). Fallback final. */
const DEFAULT_SPEED_KMH = 17;
/** Cota física urbana: nunca usar <5 (bus "parado" sostenido) ni >50 km/h. */
const SPEED_BOUNDS = [5, 50];

let cache = { buckets: null, hourAvg: null, at: 0, inflight: null };

function bucketKey(line, hourBand) {
  return `${(line || "").trim()}|${hourBand}`;
}

function clampSpeed(v) {
  return Math.min(Math.max(v, SPEED_BOUNDS[0]), SPEED_BOUNDS[1]);
}

/** Carga (cacheada) el doc de velocidades y precomputa el promedio por hora. */
async function load(admin) {
  const now = Date.now();
  if (cache.buckets && now - cache.at < CACHE_TTL_MS) return cache;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const doc = await admin.firestore().collection(SPEED_COL).doc(SPEED_DOC).get();
      const buckets = doc.exists && doc.data()?.buckets && typeof doc.data().buckets === "object"
        ? doc.data().buckets
        : {};
      // Promedio por franja horaria (fallback nivel 2 cuando falta la línea).
      const acc = {};
      for (const [k, v] of Object.entries(buckets)) {
        if (typeof v !== "number") continue;
        const hb = k.split("|")[1];
        if (hb == null) continue;
        (acc[hb] = acc[hb] || { sum: 0, n: 0 }).sum += v;
        acc[hb].n += 1;
      }
      const hourAvg = {};
      for (const [hb, { sum, n }] of Object.entries(acc)) hourAvg[hb] = sum / n;

      cache.buckets = buckets;
      cache.hourAvg = hourAvg;
      cache.at = Date.now();
      return cache;
    } catch (e) {
      // Silencioso: cualquier fallo deja la velocidad en el default global.
      cache.buckets = cache.buckets || {};
      cache.hourAvg = cache.hourAvg || {};
      cache.at = Date.now();
      return cache;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

/**
 * Devuelve `{ speedKmh, source }` para una línea y franja horaria.
 * Cascada: bucket exacto (línea×hora) → promedio de la hora → default global.
 * `source` ∈ "line-hour" | "hour" | "default" (para telemetría).
 */
async function speedForLineHour({ line, hourBand, admin }) {
  const c = await load(admin);
  const exact = c.buckets[bucketKey(line, hourBand)];
  if (typeof exact === "number") {
    return { speedKmh: clampSpeed(exact), source: "line-hour" };
  }
  const ha = c.hourAvg[String(hourBand)];
  if (typeof ha === "number") {
    return { speedKmh: clampSpeed(ha), source: "hour" };
  }
  return { speedKmh: DEFAULT_SPEED_KMH, source: "default" };
}

/** Solo para tests: limpia el cache in-memory. */
function _resetCacheForTest() {
  cache = { buckets: null, hourAvg: null, at: 0, inflight: null };
}

module.exports = {
  DEFAULT_SPEED_KMH,
  SPEED_BOUNDS,
  bucketKey,
  clampSpeed,
  speedForLineHour,
  _resetCacheForTest,
};
