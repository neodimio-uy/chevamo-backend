/**
 * Catálogo de Jurisdictions (unidades administrativas).
 *
 * Una Jurisdiction es una unidad real con gobierno + límites administrativos:
 * Mvd, Canelones, San José, Maldonado, CABA, GBA, Madrid (capital), Madrid CA,
 * Barcelona, Lisboa, São Paulo, Bogotá, etc.
 *
 * Las Jurisdictions son la unidad atómica del modelo nuevo. El user **vive**
 * en una jurisdicción (no en un blob "Area Metro"). Después la juri se compone
 * con MetroArea (composición funcional) y NationalNetwork (overlay nacional).
 *
 * Cada entry define:
 *   - id: `<country>.<slug>` (ej `uy.mvd`, `ar.caba`, `es.madrid`)
 *   - country: ISO2 lowercase
 *   - displayName: nombre humano
 *   - boundingBox: bbox geográfico para validación de coords + zoom default
 *   - defaultMapCenter: coord de fallback cuando no hay GPS
 *   - timezone: TZ IANA
 *   - locale: BCP-47
 *   - parentMetroAreaIds: 0+ MetroAreas funcionales que contienen esta juri
 *
 * Los modos disponibles se derivan de los Operators que cubren la juri (no se
 * hardcodean acá). Ver `operators.js` y `getModesForJurisdiction()`.
 */

const JURISDICTIONS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "uy.mvd",
    country: "UY",
    displayName: "Montevideo",
    boundingBox: { swLat: -34.95, swLng: -56.50, neLat: -34.71, neLng: -56.00 },
    defaultMapCenter: { lat: -34.9058, lng: -56.1913 }, // Plaza Independencia
    timezone: "America/Montevideo",
    locale: "es-UY",
    parentMetroAreaIds: ["uy.mvd-area-metro"],
  },
  {
    id: "uy.canelones",
    country: "UY",
    displayName: "Canelones",
    // Costa de Oro + Las Piedras + Pando + Ciudad de la Costa
    boundingBox: { swLat: -34.93, swLng: -56.50, neLat: -34.40, neLng: -55.30 },
    defaultMapCenter: { lat: -34.5226, lng: -56.2769 }, // Canelones capital
    timezone: "America/Montevideo",
    locale: "es-UY",
    parentMetroAreaIds: ["uy.mvd-area-metro"],
  },
  {
    id: "uy.san-jose",
    country: "UY",
    displayName: "San José",
    boundingBox: { swLat: -34.85, swLng: -57.00, neLat: -34.05, neLng: -56.50 },
    defaultMapCenter: { lat: -34.3375, lng: -56.7128 }, // San José de Mayo
    timezone: "America/Montevideo",
    locale: "es-UY",
    parentMetroAreaIds: ["uy.mvd-area-metro"],
  },
  {
    id: "uy.maldonado",
    country: "UY",
    displayName: "Maldonado / Punta del Este",
    boundingBox: { swLat: -35.10, swLng: -55.20, neLat: -34.50, neLng: -54.20 },
    defaultMapCenter: { lat: -34.9, lng: -54.95 },
    timezone: "America/Montevideo",
    locale: "es-UY",
    parentMetroAreaIds: [], // Maldonado no es parte de Area Metro Mvd
  },

  // ===========================================================================
  // ARGENTINA
  // ===========================================================================
  {
    id: "ar.caba",
    country: "AR",
    displayName: "Ciudad Autónoma de Buenos Aires",
    boundingBox: { swLat: -34.71, swLng: -58.55, neLat: -34.53, neLng: -58.33 },
    defaultMapCenter: { lat: -34.6037, lng: -58.3816 }, // Obelisco
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es-AR",
    parentMetroAreaIds: ["ar.amba"],
  },
  {
    id: "ar.gba",
    country: "AR",
    displayName: "Gran Buenos Aires",
    // 24 partidos GBA + La Plata + Brandsen
    boundingBox: { swLat: -35.30, swLng: -59.00, neLat: -34.30, neLng: -57.70 },
    defaultMapCenter: { lat: -34.7, lng: -58.5 }, // promedio partidos GBA
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es-AR",
    parentMetroAreaIds: ["ar.amba"],
  },

  // ===========================================================================
  // PORTUGAL
  // ===========================================================================
  {
    id: "pt.lisboa",
    country: "PT",
    displayName: "Lisboa",
    boundingBox: { swLat: 38.69, swLng: -9.23, neLat: 38.80, neLng: -9.07 },
    defaultMapCenter: { lat: 38.7169, lng: -9.1399 }, // Rossio
    timezone: "Europe/Lisbon",
    locale: "pt-PT",
    parentMetroAreaIds: ["pt.lisboa-area-metro"],
  },

  // ===========================================================================
  // ESPAÑA
  // ===========================================================================
  {
    id: "es.madrid",
    country: "ES",
    displayName: "Madrid",
    boundingBox: { swLat: 40.20, swLng: -4.20, neLat: 40.70, neLng: -3.40 },
    defaultMapCenter: { lat: 40.4168, lng: -3.7038 }, // Sol
    timezone: "Europe/Madrid",
    locale: "es-ES",
    parentMetroAreaIds: ["es.madrid-area-metro"],
  },
  {
    id: "es.barcelona",
    country: "ES",
    displayName: "Barcelona",
    boundingBox: { swLat: 41.20, swLng: 1.90, neLat: 41.55, neLng: 2.30 },
    defaultMapCenter: { lat: 41.3870, lng: 2.1701 }, // Plaza Catalunya
    timezone: "Europe/Madrid",
    locale: "es-ES",
    parentMetroAreaIds: ["es.barcelona-area-metro"],
  },

  // ===========================================================================
  // BRASIL
  // ===========================================================================
  {
    id: "br.sao-paulo",
    country: "BR",
    displayName: "São Paulo",
    boundingBox: { swLat: -23.911, swLng: -46.984, neLat: -23.195, neLng: -46.185 },
    defaultMapCenter: { lat: -23.5505, lng: -46.6333 }, // Sé/Centro
    timezone: "America/Sao_Paulo",
    locale: "pt-BR",
    parentMetroAreaIds: [],
  },

  // ===========================================================================
  // COLOMBIA
  // ===========================================================================
  {
    id: "co.bogota",
    country: "CO",
    displayName: "Bogotá D.C.",
    boundingBox: { swLat: 4.40, swLng: -74.30, neLat: 4.85, neLng: -73.95 },
    defaultMapCenter: { lat: 4.6097, lng: -74.0817 }, // Plaza Bolívar
    timezone: "America/Bogota",
    locale: "es-CO",
    parentMetroAreaIds: [],
  },

  // ===========================================================================
  // FINLANDIA
  // ===========================================================================
  {
    id: "fi.helsinki",
    country: "FI",
    displayName: "Helsinki",
    // HSL cubre Helsinki + Espoo + Vantaa + 9 municipios área metro.
    boundingBox: { swLat: 60.05, swLng: 24.50, neLat: 60.50, neLng: 25.40 },
    defaultMapCenter: { lat: 60.1699, lng: 24.9384 }, // Centro Helsinki
    timezone: "Europe/Helsinki",
    locale: "fi-FI",
    parentMetroAreaIds: [],
  },

  // ===========================================================================
  // ESTADOS UNIDOS
  // ===========================================================================
  {
    id: "us.minneapolis",
    country: "US",
    displayName: "Twin Cities (Minneapolis-Saint Paul)",
    boundingBox: { swLat: 44.70, swLng: -93.80, neLat: 45.20, neLng: -92.85 },
    defaultMapCenter: { lat: 44.9778, lng: -93.2650 }, // Downtown Minneapolis
    timezone: "America/Chicago",
    locale: "en-US",
    parentMetroAreaIds: [],
  },

  // ===========================================================================
  // AUSTRALIA
  // ===========================================================================
  {
    id: "au.brisbane",
    country: "AU",
    displayName: "Brisbane / SE Queensland",
    // TransLink cubre Brisbane + Gold Coast + Sunshine Coast + Toowoomba.
    boundingBox: { swLat: -28.30, swLng: 152.50, neLat: -26.40, neLng: 153.55 },
    defaultMapCenter: { lat: -27.4698, lng: 153.0251 }, // Brisbane CBD
    timezone: "Australia/Brisbane",
    locale: "en-AU",
    parentMetroAreaIds: [],
  },
];

const JURISDICTIONS_BY_ID = Object.fromEntries(JURISDICTIONS.map((j) => [j.id, j]));

function getJurisdiction(id) {
  return JURISDICTIONS_BY_ID[id] || null;
}

/**
 * Devuelve true si una coord cae en el bbox de la jurisdicción.
 */
function inJurisdictionBounds(jurisdiction, lat, lng) {
  if (!jurisdiction || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = jurisdiction.boundingBox;
  return lat >= b.swLat && lat <= b.neLat && lng >= b.swLng && lng <= b.neLng;
}

/**
 * Detecta la jurisdicción que contiene una coord. Si varias matchean (overlapping
 * bboxes), devuelve la de bbox más chico (más específica).
 */
function detectJurisdiction(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const matches = JURISDICTIONS.filter((j) => inJurisdictionBounds(j, lat, lng));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Devolver la juri más específica (bbox menor área)
  matches.sort((a, b) => bboxArea(a.boundingBox) - bboxArea(b.boundingBox));
  return matches[0];
}

function bboxArea(b) {
  return (b.neLat - b.swLat) * (b.neLng - b.swLng);
}

module.exports = {
  JURISDICTIONS,
  JURISDICTIONS_BY_ID,
  getJurisdiction,
  inJurisdictionBounds,
  detectJurisdiction,
};
