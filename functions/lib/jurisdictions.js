/**
 * Catálogo de Jurisdictions (unidades administrativas).
 *
 * Una Jurisdiction es una unidad real con gobierno + límites administrativos:
 * Mvd, CABA, GBA, etc.
 *
 * Las Jurisdictions son la unidad atómica del modelo nuevo. El user **vive**
 * en una jurisdicción (no en un blob "Area Metro"). Después la juri se compone
 * con MetroArea (composición funcional) y NationalNetwork (overlay nacional).
 *
 * Cada entry define:
 *   - id: `<country>.<slug>` (ej `uy.mvd`, `ar.caba`)
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
