/**
 * Catálogo de ciudades soportadas por Vamo (single source of truth).
 *
 * Cada entry define:
 *   - id: identificador único `<country>.<zone>` (ej `uy.mvd-area-metro`)
 *   - country, zone: ISO2 + slug
 *   - displayName: nombre humano para logs / debug (UI usa locale-aware names)
 *   - boundingBox: bbox geográfico para validación de coords
 *   - defaultMapCenter: coord de fallback cuando no hay GPS del user
 *   - timezone: TZ IANA
 *   - locale: BCP-47
 *   - modes: por modo (`bus`, `subte`, `bike`, `tren`, `ferry`):
 *       - dataMode: `official` | `staticOnly` | `communityOnly` | `hybrid`
 *       - feed: identificador de adapter en registry.js (cuando dataMode != communityOnly)
 *       - service?: variante del feed si aplica (ej `urban`, `suburban`, `long-distance`)
 *
 * Para sumar ciudad nueva:
 *   1. Agregar entry acá con dataMode adecuado por modo
 *   2. Si tiene feed oficial, asegurar que el adapter está registrado en registry.js
 *   3. Si es nuevo modo o nuevo feed, crear adapter custom (box sanitizador Zod)
 *      o usar gtfs-rt-generic si el feed es GTFS-Realtime estándar
 *
 * NO hardcodear estos datos en otros archivos — siempre leer de acá.
 */

const CITIES = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "uy.mvd-area-metro",
    country: "UY",
    zone: "mvd-area-metro",
    displayName: "Área Metropolitana de Montevideo",
    boundingBox: { swLat: -34.95, swLng: -56.50, neLat: -34.40, neLng: -55.80 },
    defaultMapCenter: { lat: -34.9058, lng: -56.1913 }, // Plaza Independencia
    timezone: "America/Montevideo",
    locale: "es-UY",
    modes: {
      bus: {
        dataMode: "official",
        feed: "imm-stm",
        service: "urban", // STM Mvd urbano
      },
      taxi: { dataMode: "communityOnly" },
    },
  },
];

const CITIES_BY_ID = Object.fromEntries(CITIES.map((c) => [c.id, c]));

/**
 * Resuelve un CityConfig por (country, zone) — ambos requeridos.
 * Devuelve null si no existe.
 */
function getCity(country, zone) {
  if (!country || !zone) return null;
  const id = `${country.toLowerCase()}.${zone.toLowerCase()}`;
  return CITIES_BY_ID[id] || null;
}

/**
 * Resuelve el modo activo para una ciudad. `mode` puede traer `service`
 * sufijo (`bus.suburban`) — eso permite distinguir variantes del mismo modo
 * (urban vs suburban vs long-distance).
 */
function getMode(city, mode, service) {
  if (!city) return null;
  // Busca primero `mode.service` (ej `bus.suburban`), después `mode` solo
  if (service) {
    const composite = `${mode}.${service}`;
    if (city.modes[composite]) return city.modes[composite];
  }
  return city.modes[mode] || null;
}

/**
 * Devuelve true si una coord cae dentro del bbox de la ciudad.
 */
function inCityBounds(city, lat, lng) {
  if (!city || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = city.boundingBox;
  return lat >= b.swLat && lat <= b.neLat && lng >= b.swLng && lng <= b.neLng;
}

module.exports = {
  CITIES,
  CITIES_BY_ID,
  getCity,
  getMode,
  inCityBounds,
};
