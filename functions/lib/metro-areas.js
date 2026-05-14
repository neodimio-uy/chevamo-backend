/**
 * Catálogo de MetroAreas (composiciones funcionales de jurisdicciones).
 *
 * Una MetroArea es la "experiencia diaria" del user: cómo viaja realmente,
 * cruzando límites administrativos. Ej:
 *   - Mvd Area Metro = [Mvd]
 *   - AMBA = [CABA, GBA] (24 partidos + capital federal — el SUBE corre todo)
 *
 * MetroArea NO es una entidad legal — es un constructo de Vamo para que el
 * user pueda descargar "Mvd Area Metro" o "AMBA" y quede cubierto.
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
 *   - Operadores que sirven solo a UNA juri del MetroArea
 *   - Operadores que sirven al MetroArea completo
 *   - Múltiples operadores aportando datos al mismo modo
 */

const METRO_AREAS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "uy.mvd-area-metro",
    displayName: "Área Metropolitana de Montevideo",
    jurisdictionIds: ["uy.mvd"],
    boundingBox: { swLat: -34.95, swLng: -57.00, neLat: -34.05, neLng: -55.30 },
    defaultMapCenter: { lat: -34.9058, lng: -56.1913 }, // Plaza Independencia
    timezone: "America/Montevideo",
    locale: "es-UY",
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
