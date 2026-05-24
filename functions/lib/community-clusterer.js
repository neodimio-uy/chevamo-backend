/**
 * Agrupa reportes individuales de `community_buses` en clusters (mismo
 * bus físico reportado por múltiples users).
 *
 * Port simplificado de iOS `CommunityReportManager.clusteredLiveBuses()`.
 *
 * **Heurística de agrupación:**
 *   - Misma `line` + mismo `lineVariantId` (estricto)
 *   - Distancia entre reportes < `CLUSTER_RADIUS_M` (30m default — bus
 *     físico mide ~12m, los users a bordo están dentro de eso + margen GPS)
 *
 * No requiere `speed` similarity como filtro extra — la línea + variant +
 * radio chico ya elimina la mayoría de falsos clusters.
 *
 * **Output:** array de clusters, cada cluster con `representative` (el reporte
 * más reciente) + `reporterIds` (todos los uids) + `reporterCount`.
 *
 * Función pura. No toca Firestore.
 */

const positionFuser = require("./position-fuser");

const CLUSTER_RADIUS_M = 30;

/**
 * Agrupa una lista de community reports en clusters.
 *
 * @param {Array} reports — cada uno con `{ id, userId, line, lineVariantId,
 *   lat, lng, speed, updatedAt, startedAt, officialBusId, company,
 *   origin, destination }`
 * @returns {Array} clusters `[{ representative, reporterIds:Set, reporterCount,
 *   officialBusId }]`
 */
function cluster(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return [];

  // Ordenamos por updatedAt descendente — el más fresco se vuelve representative
  // del grupo. iOS hace lo mismo.
  const sorted = [...reports].sort((a, b) => {
    const aMs = toMillis(a.updatedAt);
    const bMs = toMillis(b.updatedAt);
    return bMs - aMs;
  });

  const clusters = [];
  const claimed = new Set(); // ids ya agrupados

  for (const r of sorted) {
    if (claimed.has(r.id)) continue;
    claimed.add(r.id);

    const reporterIds = new Set([r.userId]);
    let officialBusId = r.officialBusId || null;

    // Buscar matches en el resto
    for (const other of sorted) {
      if (claimed.has(other.id)) continue;
      if ((other.line || "").trim() !== (r.line || "").trim()) continue;
      if (other.lineVariantId !== r.lineVariantId) continue;
      const dist = positionFuser.haversineMeters(
        { lat: r.lat, lng: r.lng },
        { lat: other.lat, lng: other.lng },
      );
      if (dist > CLUSTER_RADIUS_M) continue;
      claimed.add(other.id);
      reporterIds.add(other.userId);
      if (!officialBusId && other.officialBusId) {
        officialBusId = other.officialBusId;
      }
    }

    clusters.push({
      representative: r,
      reporterIds,
      reporterCount: reporterIds.size,
      officialBusId,
    });
  }

  return clusters;
}

/** Util: convierte Firestore Timestamp o Date o number a ms. */
function toMillis(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6;
  return 0;
}

/** Util público: segundos desde un timestamp Firestore-ish hasta `now`. */
function ageSeconds(timestamp, now = Date.now()) {
  return Math.max(0, (now - toMillis(timestamp)) / 1000);
}

module.exports = {
  CLUSTER_RADIUS_M,
  cluster,
  toMillis,
  ageSeconds,
};
