/**
 * Catálogo de NationalNetworks (overlays nacionales que cruzan jurisdicciones).
 *
 * Una NationalNetwork es un sistema de transporte que opera a escala nacional
 * (o multi-jurisdiccional grande) y NO se asocia a una ciudad específica:
 *   - UY: MTOP Interdepartamental (futuro)
 *   - ES: Renfe Larga Distancia (futuro)
 *
 * Diferencia con MetroArea: MetroArea es una experiencia urbana cotidiana
 * (commute diario). NationalNetwork es una experiencia de viaje ocasional
 * (vacaciones, trabajo cross-país).
 *
 * Hoy v1.0 no tiene NationalNetworks activas (scope reducido a Mvd urbano + AMBA).
 * Cuando se sumen, agregar entries con:
 *   - id: `<country>.<slug>`
 *   - displayName, country, jurisdictionsServed
 *   - boundingBox, defaultMapCenter, timezone, locale
 *
 * Feeds: viven en Operator con `coverage.nationalNetworks`.
 */

const NATIONAL_NETWORKS = [];

const NATIONAL_NETWORKS_BY_ID = Object.fromEntries(NATIONAL_NETWORKS.map((n) => [n.id, n]));

function getNationalNetwork(id) {
  return NATIONAL_NETWORKS_BY_ID[id] || null;
}

/**
 * Devuelve las NationalNetworks que sirven a una jurisdicción.
 */
function getNetworksForJurisdiction(jurisdictionId) {
  return NATIONAL_NETWORKS.filter((n) => n.jurisdictionsServed.includes(jurisdictionId));
}

function inNetworkBounds(network, lat, lng) {
  if (!network || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = network.boundingBox;
  return lat >= b.swLat && lat <= b.neLat && lng >= b.swLng && lng <= b.neLng;
}

module.exports = {
  NATIONAL_NETWORKS,
  NATIONAL_NETWORKS_BY_ID,
  getNationalNetwork,
  getNetworksForJurisdiction,
  inNetworkBounds,
};
