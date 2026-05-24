/**
 * Fusiona la posición de un bus físico cuando hay datos de IMM y un cluster
 * comunitario al mismo tiempo.
 *
 * Port directo de iOS `Vamo/Models/PositionFuser.swift`. Estrategia:
 * **promedio ponderado por `confidence × freshness`** de cada fuente.
 *
 * **Simétrico:** IMM y Comunidad son fuentes complementarias del mismo
 * nivel conceptual. El algoritmo no privilegia hard-coded a una sobre la
 * otra; cada una contribuye según su confianza actual.
 *
 * **Validación previa:** antes de fusionar, valida que IMM y cluster son
 * realmente el mismo bus físico:
 *   1. Mismo `lineVariantId` (obligatorio).
 *   2. Distancia entre posiciones < `MAX_FUSION_DISTANCE_M` (250m default).
 *      Salvaguarda contra promediar dos buses distintos que casualmente
 *      están cerca.
 *
 * Si la validación falla, devuelve null — caller debe mostrar separados.
 */

const sourceConfidence = require("./source-confidence");

/** Salvaguarda: si las dos posiciones están más lejos que esto, NO promediar. */
const MAX_FUSION_DISTANCE_M = 250;

/** Radio de match para `sameVehicle` cuando no hay trail temporal disponible. */
const COMMUNITY_MATCH_RADIUS_M = 300;

/** Haversine en metros entre dos coords {lat, lng}. Duplicado de index.js:551
 *  para no acoplar este módulo al monolito. ~10 líneas, OK duplicar. */
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Fusiona dos posiciones del mismo bus físico.
 *
 * @param {object} opts
 *   - immCoord: { lat, lng }
 *   - immAge: segundos
 *   - immConfidence: 0-1 (usar sourceConfidence.forIMM)
 *   - comCoord: { lat, lng }
 *   - comAge: segundos
 *   - comConfidence: 0-1 (usar sourceConfidence.forCommunity)
 * @returns {object|null}
 *   - { coordinate: {lat, lng}, weightIMM, weightCommunity, effectiveAgeSeconds }
 *   - null si los inputs son incoherentes (distintos buses por distancia)
 */
function fuse({ immCoord, immAge, immConfidence, comCoord, comAge, comConfidence }) {
  const dist = haversineMeters(immCoord, comCoord);
  if (dist > MAX_FUSION_DISTANCE_M) {
    // Buses distintos disfrazados de match espacial. No fusionar.
    return null;
  }

  const wIMM = immConfidence * sourceConfidence.freshnessScore(immAge);
  const wCom = comConfidence * sourceConfidence.freshnessScore(comAge);
  const total = wIMM + wCom;

  if (total <= 0) {
    // Ambas fuentes con peso cero (muy stale, zombie, etc.).
    // Devolver la menos vieja como fallback, sin fusión real.
    return {
      coordinate: immAge < comAge ? immCoord : comCoord,
      weightIMM: 0,
      weightCommunity: 0,
      effectiveAgeSeconds: Math.min(immAge, comAge),
    };
  }

  const lat = (immCoord.lat * wIMM + comCoord.lat * wCom) / total;
  const lng = (immCoord.lng * wIMM + comCoord.lng * wCom) / total;
  return {
    coordinate: { lat, lng },
    weightIMM: wIMM / total,
    weightCommunity: wCom / total,
    effectiveAgeSeconds: Math.min(immAge, comAge),
  };
}

/**
 * Decide si un bus IMM y un cluster comunitario son el mismo vehículo
 * físico antes de fusionar.
 *
 * Reglas (port de iOS `PositionFuser.sameVehicle`):
 *   1. Misma línea + mismo `lineVariantId` (estricto)
 *   2. Distancia espacial < `COMMUNITY_MATCH_RADIUS_M`
 *
 * Acá NO tenemos `BusArrivalTrail` server-side todavía (lo deja iOS
 * para edge cases). Sin trail, decidimos por línea + variant + distancia.
 */
function sameVehicle({
  immLine, immVariantId, immCoord,
  clusterLine, clusterVariantId, clusterCoord,
}) {
  if (!immLine || !clusterLine) return false;
  if (immLine.trim() !== clusterLine.trim()) return false;
  if (immVariantId !== clusterVariantId) return false;
  const dist = haversineMeters(immCoord, clusterCoord);
  return dist <= COMMUNITY_MATCH_RADIUS_M;
}

module.exports = {
  MAX_FUSION_DISTANCE_M,
  COMMUNITY_MATCH_RADIUS_M,
  fuse,
  sameVehicle,
  haversineMeters,
};
