/**
 * Cache in-memory de reportes activos en `community_buses`.
 *
 * **Patrón:** lazy fetch con TTL 30s + dedupe in-flight. NO usa un cron
 * dedicado — el primer request a `getActiveByLine()` después de que expira
 * el TTL gatilla el fetch a Firestore. Los próximos requests dentro de la
 * ventana usan el cache.
 *
 * **Por qué no cron:** evita agregar otro export de scheduler. Con
 * `minInstances: 1` y traffic real, la instancia siempre tiene un cache
 * caliente.
 *
 * **Frescura efectiva:** hasta 30s de stale. La app iOS sigue teniendo su
 * propio listener Firestore realtime para `community_buses` — el server
 * solo necesita visibilidad agregada para enriquecer `/upcoming`. Una vez
 * que web/Android estén live y dependan del server, podemos bajar a 10s.
 *
 * **Filtros:** solo reports con `updatedAt > now - 5min` (descartamos stale
 * conservadoramente, el límite "real" de iOS es 90s pero acá tenemos
 * margen para que el cron de cleanup haga su trabajo).
 *
 * **Output del cache:** `Map<lineKey, CommunityReport[]>` donde `lineKey`
 * es la `line` trimmed. Cada lookup `getActiveByLine(line)` devuelve el
 * array (vacío si no hay).
 */

const { logger } = require("firebase-functions");
const clusterer = require("./community-clusterer");

const CACHE_TTL_MS = 30 * 1000; // 30s
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5min

let cachedMap = null;        // Map<lineKey, CommunityReport[]>
let cachedAt = 0;            // ms
let inflightPromise = null;  // dedupe concurrent fetches

/**
 * Fetcha todos los reports activos de Firestore y agrupa por línea.
 * NO clusterea — eso se hace por-request en el caller para poder filtrar
 * por proximidad a la parada destino.
 */
async function refresh(admin) {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - ACTIVE_WINDOW_MS);
    const snap = await admin.firestore()
      .collection("community_buses")
      .where("updatedAt", ">", cutoff)
      .get();

    const byLine = new Map();
    snap.forEach((doc) => {
      const d = doc.data();
      const line = (d.line || "").trim();
      if (!line) return;
      const report = {
        id: doc.id,
        userId: d.userId,
        line,
        lineVariantId: d.lineVariantId,
        company: d.company,
        origin: d.origin,
        destination: d.destination,
        lat: d.lat,
        lng: d.lng,
        speed: d.speed, // m/s
        updatedAt: d.updatedAt,
        startedAt: d.startedAt,
        officialBusId: d.officialBusId || null,
      };
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(report);
    });

    cachedMap = byLine;
    cachedAt = Date.now();
    return cachedMap;
  } catch (e) {
    // Silencioso: si Firestore falla, mantenemos el cache previo (puede
    // ser null o stale). La fusion comunidad simplemente no se aplica.
    logger.warn(`community-cache refresh failed: ${e.message}`);
    cachedMap = cachedMap || new Map();
    cachedAt = Date.now(); // evita retry inmediato
    return cachedMap;
  } finally {
    inflightPromise = null;
  }
}

/** Refresh con dedupe de concurrent calls. */
async function ensureFresh(admin) {
  const now = Date.now();
  if (cachedMap && now - cachedAt < CACHE_TTL_MS) return cachedMap;
  if (inflightPromise) return inflightPromise;
  inflightPromise = refresh(admin);
  return inflightPromise;
}

/**
 * Devuelve reports activos para una línea específica. Trigger lazy refresh
 * si el cache expiró.
 *
 * @param {string} line — ej "121", "CA1"
 * @param {object} admin — firebase-admin instance
 * @returns {Promise<Array>} reports (puede ser empty)
 */
async function getActiveByLine(line, admin) {
  const key = (line || "").trim();
  if (!key) return [];
  const map = await ensureFresh(admin);
  return map.get(key) || [];
}

/**
 * Devuelve clusters comunitarios activos para una línea. Combina lookup +
 * clustering. Útil para el handler /upcoming que necesita una vista
 * "1 cluster = 1 bus físico".
 */
async function getActiveClustersByLine(line, admin) {
  const reports = await getActiveByLine(line, admin);
  return clusterer.cluster(reports);
}

/**
 * Devuelve TODOS los clusters comunitarios activos agrupados por línea.
 * Versión global de `getActiveClustersByLine` — itera todo el cache y
 * clusteriza cada línea por separado. Útil para `/buses` global (Función 2
 * de la visión Comunidad) donde necesitamos fusionar IMM + Comunidad sin
 * scope de parada.
 *
 * Líneas sin clusters (solo reports stale o sin agrupar) no entran al map.
 */
async function getAllActiveClustersMap(admin) {
  const map = await ensureFresh(admin);
  const out = new Map();
  for (const [line, reports] of map.entries()) {
    const clusters = clusterer.cluster(reports);
    if (clusters.length > 0) out.set(line, clusters);
  }
  return out;
}

/**
 * Stats para `/admin/diagnostics`.
 */
function stats() {
  if (!cachedMap) return { warmed: false, lines: 0, reportsTotal: 0, cachedAgeMs: null };
  let total = 0;
  for (const arr of cachedMap.values()) total += arr.length;
  return {
    warmed: true,
    lines: cachedMap.size,
    reportsTotal: total,
    cachedAgeMs: Date.now() - cachedAt,
    cacheTtlMs: CACHE_TTL_MS,
    activeWindowMs: ACTIVE_WINDOW_MS,
  };
}

/** Reset (tests). */
function _resetCache() {
  cachedMap = null;
  cachedAt = 0;
  inflightPromise = null;
}

module.exports = {
  CACHE_TTL_MS,
  ACTIVE_WINDOW_MS,
  ensureFresh,
  getActiveByLine,
  getActiveClustersByLine,
  getAllActiveClustersMap,
  stats,
  _resetCache,
};
