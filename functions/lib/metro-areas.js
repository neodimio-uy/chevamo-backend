/**
 * Catálogo de MetroAreas (composiciones funcionales de jurisdicciones).
 *
 * Una MetroArea es la "experiencia diaria" del user: cómo viaja realmente,
 * cruzando límites administrativos. Ej:
 *   - Mvd Area Metro = [Mvd, Canelones, San José] (commuters de Costa de Oro,
 *     Las Piedras, Pando, Ciudad de la Costa que trabajan en Mvd)
 *   - AMBA = [CABA, GBA] (24 partidos + capital federal — el SUBE corre todo)
 *   - Madrid Area Metro = [Madrid (capital), eventualmente Comunidad completa]
 *
 * MetroArea NO es una entidad legal — es un constructo de Vamo para que el
 * user que vive en Canelones pero viaja a Mvd no tenga que descargar 2 cosas
 * por separado: descarga "Mvd Area Metro" y queda cubierto.
 *
 * Cada entry define:
 *   - id: `<country>.<slug>-area-metro` o similar
 *   - displayName: nombre humano
 *   - jurisdictionIds: lista ordenada (primary primero) de jurisdicciones
 *   - boundingBox: bbox almacenado (NO computado al vuelo — control fino del
 *     default zoom y para detección rápida)
 *   - defaultMapCenter: coord de fallback
 *   - timezone, locale: del primary
 *
 * Decisión arquitectural: feeds NO se almacenan acá. Los feeds viven en
 * `Operator` con `coverage.metroAreas`. Esto permite:
 *   - Operadores que sirven solo a UNA juri del MetroArea (ej. IMM solo Mvd)
 *   - Operadores que sirven al MetroArea completo (ej. MTOP suburbano cubre
 *     Mvd + Canelones + San José en un solo feed)
 *   - Múltiples operadores aportando datos al mismo modo
 */

const METRO_AREAS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "uy.mvd-area-metro",
    displayName: "Área Metropolitana de Montevideo",
    jurisdictionIds: ["uy.mvd", "uy.canelones", "uy.san-jose"],
    boundingBox: { swLat: -34.95, swLng: -57.00, neLat: -34.05, neLng: -55.30 },
    defaultMapCenter: { lat: -34.9058, lng: -56.1913 }, // Plaza Independencia
    timezone: "America/Montevideo",
    locale: "es-UY",
  },

  // ===========================================================================
  // ARGENTINA
  // ===========================================================================
  {
    id: "ar.amba",
    displayName: "Área Metropolitana de Buenos Aires",
    jurisdictionIds: ["ar.caba", "ar.gba"],
    boundingBox: { swLat: -35.30, swLng: -59.00, neLat: -34.30, neLng: -57.70 },
    defaultMapCenter: { lat: -34.6037, lng: -58.3816 }, // Obelisco
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es-AR",
  },

  // ===========================================================================
  // PORTUGAL
  // ===========================================================================
  {
    id: "pt.lisboa-area-metro",
    displayName: "Área Metropolitana de Lisboa",
    // Hoy solo Lisboa capital; cuando se sumen Sintra/Cascais/Almada/etc.
    // como jurisdicciones individuales, agregarlas acá.
    jurisdictionIds: ["pt.lisboa"],
    boundingBox: { swLat: 38.50, swLng: -9.55, neLat: 39.10, neLng: -8.70 },
    defaultMapCenter: { lat: 38.7169, lng: -9.1399 }, // Rossio
    timezone: "Europe/Lisbon",
    locale: "pt-PT",
  },

  // ===========================================================================
  // ESPAÑA
  // ===========================================================================
  {
    id: "es.madrid-area-metro",
    displayName: "Comunidad de Madrid",
    // Hoy solo Madrid capital; cuando se sumen municipios CAM (Móstoles,
    // Alcalá, Getafe, etc.), agregarlos acá.
    jurisdictionIds: ["es.madrid"],
    boundingBox: { swLat: 40.20, swLng: -4.20, neLat: 40.70, neLng: -3.40 },
    defaultMapCenter: { lat: 40.4168, lng: -3.7038 }, // Sol
    timezone: "Europe/Madrid",
    locale: "es-ES",
  },
  {
    id: "es.barcelona-area-metro",
    displayName: "Área Metropolitana de Barcelona",
    jurisdictionIds: ["es.barcelona"],
    boundingBox: { swLat: 41.20, swLng: 1.90, neLat: 41.55, neLng: 2.30 },
    defaultMapCenter: { lat: 41.3870, lng: 2.1701 },
    timezone: "Europe/Madrid",
    locale: "es-ES",
  },
];

const METRO_AREAS_BY_ID = Object.fromEntries(METRO_AREAS.map((m) => [m.id, m]));

function getMetroArea(id) {
  return METRO_AREAS_BY_ID[id] || null;
}

/**
 * Devuelve los MetroAreas a los que pertenece una jurisdicción.
 */
function getMetroAreasForJurisdiction(jurisdictionId) {
  return METRO_AREAS.filter((m) => m.jurisdictionIds.includes(jurisdictionId));
}

function inMetroAreaBounds(metroArea, lat, lng) {
  if (!metroArea || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = metroArea.boundingBox;
  return lat >= b.swLat && lat <= b.neLat && lng >= b.swLng && lng <= b.neLng;
}

module.exports = {
  METRO_AREAS,
  METRO_AREAS_BY_ID,
  getMetroArea,
  getMetroAreasForJurisdiction,
  inMetroAreaBounds,
};
