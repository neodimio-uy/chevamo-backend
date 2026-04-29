/**
 * Catálogo de NationalNetworks (overlays nacionales que cruzan jurisdicciones).
 *
 * Una NationalNetwork es un sistema de transporte que opera a escala nacional
 * (o multi-jurisdiccional grande) y NO se asocia a una ciudad específica:
 *   - UY: MTOP Interdepartamental (Mvd ↔ Punta del Este, Mvd ↔ Salto, etc.)
 *   - ES: Renfe Larga Distancia (Madrid ↔ Barcelona ↔ Sevilla, AVE)
 *   - AR: Trenes Argentinos Larga Distancia (futuro)
 *   - BR: ANTT Interestatal (futuro)
 *
 * Diferencia con MetroArea: MetroArea es una experiencia urbana cotidiana
 * (commute diario). NationalNetwork es una experiencia de viaje ocasional
 * (vacaciones, trabajo cross-país).
 *
 * Cada entry define:
 *   - id: `<country>.<slug>` (ej `uy.long-distance`, `es.larga-distancia`)
 *   - displayName: nombre humano
 *   - country: ISO2 — null si es realmente cross-country (no aplica hoy)
 *   - jurisdictionsServed: lista (NO exhaustiva — Renfe LD para a casi cualquier
 *     capital ES; usamos esto para sugerencias proactivas, no como filtro hard)
 *   - boundingBox: bbox geográfico (España continental, UY, etc.)
 *   - defaultMapCenter: coord de fallback (capital del país)
 *   - timezone, locale
 *
 * Feeds: viven en Operator con `coverage.nationalNetworks` (igual que MetroArea).
 */

const NATIONAL_NETWORKS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "uy.long-distance",
    displayName: "Larga distancia interdepartamental Uruguay",
    country: "UY",
    jurisdictionsServed: [
      "uy.mvd", "uy.canelones", "uy.san-jose", "uy.maldonado",
      // Resto del país pendiente catalogar como jurisdicciones individuales
      // (Colonia, Salto, Paysandú, Tacuarembó, Rivera, Rocha, etc.)
    ],
    boundingBox: { swLat: -35.00, swLng: -58.50, neLat: -30.00, neLng: -53.00 },
    defaultMapCenter: { lat: -33.0, lng: -56.0 },
    timezone: "America/Montevideo",
    locale: "es-UY",
  },

  // ===========================================================================
  // PAÍSES BAJOS — red nacional unificada (OVapi agrega TODOS los operadores)
  // ===========================================================================
  {
    id: "nl.netherlands",
    displayName: "Países Bajos — red nacional",
    country: "NL",
    // OVapi/NDOV agrega NS (trenes nacional), GVB (Amsterdam), RET (Rotterdam),
    // HTM (La Haya), Connexxion, Arriva, Qbuzz y más en un solo feed.
    jurisdictionsServed: [],  // sin sub-jurisdicciones catalogadas hoy — feed cubre todo
    boundingBox: { swLat: 50.75, swLng: 3.20, neLat: 53.55, neLng: 7.25 },
    defaultMapCenter: { lat: 52.3676, lng: 4.9041 }, // Amsterdam centro
    timezone: "Europe/Amsterdam",
    locale: "nl-NL",
  },

  // ===========================================================================
  // ESPAÑA
  // ===========================================================================
  {
    id: "es.larga-distancia",
    displayName: "Renfe Larga Distancia (España)",
    country: "ES",
    jurisdictionsServed: [
      "es.madrid", "es.barcelona",
      // Sevilla, Valencia, Málaga, Bilbao, Zaragoza, etc. pendientes catalogar.
    ],
    // España continental + Baleares (Mallorca tiene Renfe SFM aparte)
    boundingBox: { swLat: 35.50, swLng: -9.50, neLat: 44.00, neLng: 4.50 },
    defaultMapCenter: { lat: 40.4168, lng: -3.7038 }, // Madrid (capital)
    timezone: "Europe/Madrid",
    locale: "es-ES",
  },
];

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
