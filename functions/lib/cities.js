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
      "bus.suburban": {
        // Suburbano UY (Canelones / San José / Costa de Oro): el feed STM
        // de Mvd trae 254+ buses live de empresas suburbanas (COPSA, CITA,
        // CASANOVA, COIT, SAN ANTONIO, ZEBALLOS, RUTAS DEL NORTE). Adapter
        // `imm-stm-suburban` filtra por empresa. Combina con snapshot GTFS
        // estático MTOP (paradas + horarios + recorridos) en el cliente.
        dataMode: "official",
        feed: "imm-stm-suburban",
        service: "suburban",
      },
      taxi:  { dataMode: "communityOnly" },
      remis: { dataMode: "communityOnly" },
    },
  },
  {
    id: "uy.long-distance",
    country: "UY",
    zone: "long-distance",
    displayName: "Larga distancia interdepartamental Uruguay",
    boundingBox: { swLat: -35.00, swLng: -58.50, neLat: -30.00, neLng: -53.00 },
    defaultMapCenter: { lat: -33.0, lng: -56.0 },
    timezone: "America/Montevideo",
    locale: "es-UY",
    modes: {
      bus: {
        // MTOP no expone GPS oficial — paradas + horarios + recorridos vienen
        // del GTFS estático (`mtop-longdistance-static`). Cuando exista feed
        // RT (community contributed o futuro adapter), bajar a hybrid/official.
        dataMode: "staticOnly",
        service: "long-distance",
      },
    },
  },
  {
    id: "uy.maldonado",
    country: "UY",
    zone: "maldonado",
    displayName: "Maldonado / Punta del Este",
    boundingBox: { swLat: -35.10, swLng: -55.20, neLat: -34.50, neLng: -54.20 },
    defaultMapCenter: { lat: -34.9, lng: -54.95 }, // Maldonado capital
    timezone: "America/Montevideo",
    locale: "es-UY",
    modes: {
      bus: {
        // CODESA Maldonado/Punta del Este. Adapter `codesa-avl` consume
        // `http://ip.codesa.com.uy/pub/avl.xml` (Busmatick Server, refresh
        // cada 15s, sin auth, CORS abierto). Validado live 2026-04-27.
        dataMode: "official",
        feed: "codesa-avl",
      },
      // Taxi/Remis: pendiente — primero Mvd, después se suma.
    },
  },

  // ===========================================================================
  // ARGENTINA
  // ===========================================================================
  {
    id: "ar.amba",
    country: "AR",
    zone: "amba",
    displayName: "Área Metropolitana de Buenos Aires",
    // CABA + 24 partidos GBA + La Plata + Brandsen
    boundingBox: { swLat: -35.30, swLng: -59.00, neLat: -34.30, neLng: -57.70 },
    defaultMapCenter: { lat: -34.6037, lng: -58.3816 }, // Obelisco
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es-AR",
    modes: {
      bus: {
        dataMode: "official",
        feed: "gcba-vehicles-simple",
      },
      subte: {
        dataMode: "official",
        feed: "gcba-subte-forecast",
      },
      bike: {
        dataMode: "official",
        feed: "gcba-ecobici-gbfs",
      },
      // Taxi/Remis AMBA: pendiente — primero Mvd, después se suma.
    },
  },

  // ===========================================================================
  // PORTUGAL
  // ===========================================================================
  {
    id: "pt.lisboa-area-metro",
    country: "PT",
    zone: "lisboa-area-metro",
    displayName: "Área Metropolitana de Lisboa",
    boundingBox: { swLat: 38.50, swLng: -9.55, neLat: 39.10, neLng: -8.70 },
    defaultMapCenter: { lat: 38.7169, lng: -9.1399 }, // Rossio
    timezone: "Europe/Lisbon",
    locale: "pt-PT",
    modes: {
      bus: {
        dataMode: "official",
        feed: "cm-lisboa-vehicles",
      },
      // metro de Lisboa pendiente — agregar cuando se mapee endpoint
      // tren CP pendiente
    },
  },

  // ===========================================================================
  // ESPAÑA — placeholders de ciudades grandes (feeds a integrar incrementalmente)
  // ===========================================================================
  {
    id: "es.madrid-area-metro",
    country: "ES",
    zone: "madrid-area-metro",
    displayName: "Comunidad de Madrid",
    boundingBox: { swLat: 40.20, swLng: -4.20, neLat: 40.70, neLng: -3.40 },
    defaultMapCenter: { lat: 40.4168, lng: -3.7038 }, // Sol
    timezone: "Europe/Madrid",
    locale: "es-ES",
    modes: {
      bus: {
        // EMT Madrid requiere OAuth — feed pendiente de implementar
        dataMode: "communityOnly",
      },
      subte: {
        // Metro de Madrid — sin GTFS-RT público hoy
        dataMode: "communityOnly",
      },
      tren: {
        // Renfe Cercanías Madrid — GTFS estático público (datos.gob.es)
        dataMode: "staticOnly",
        service: "cercanias",
      },
      bike: {
        // BiciMAD GBFS — pendiente integrar
        dataMode: "communityOnly",
      },
    },
  },
  {
    id: "es.barcelona-area-metro",
    country: "ES",
    zone: "barcelona-area-metro",
    displayName: "Área Metropolitana de Barcelona",
    boundingBox: { swLat: 41.20, swLng: 1.90, neLat: 41.55, neLng: 2.30 },
    defaultMapCenter: { lat: 41.3870, lng: 2.1701 }, // Plaza Catalunya
    timezone: "Europe/Madrid",
    locale: "es-ES",
    modes: {
      bus:   { dataMode: "communityOnly" }, // TMB pendiente registro
      subte: { dataMode: "communityOnly" }, // L1-L11 metro Barcelona
      tren:  { dataMode: "staticOnly", service: "cercanias" }, // Renfe Rodalies
    },
  },

  {
    id: "es.larga-distancia",
    country: "ES",
    zone: "larga-distancia",
    displayName: "Renfe Larga Distancia (España)",
    // España continental + Baleares (Mallorca tiene Renfe SFM aparte, pero
    // el bbox cubre por si entra). El feed es nacional — todos los trenes
    // Larga Distancia de la península aparecen acá.
    boundingBox: { swLat: 35.50, swLng: -9.50, neLat: 44.00, neLng: 4.50 },
    defaultMapCenter: { lat: 40.4168, lng: -3.7038 }, // Madrid
    timezone: "Europe/Madrid",
    locale: "es-ES",
    modes: {
      tren: {
        // GTFS-RT JSON estándar publicado por Renfe.
        // `https://gtfsrt.renfe.com/vehicle_positions_LD.json`. Validado live
        // 2026-04-27 — ~140 trenes en circulación a hora pico.
        dataMode: "official",
        feed: "renfe-largadistancia-json",
      },
    },
  },

  // ===========================================================================
  // BRASIL
  // ===========================================================================
  {
    id: "br.sao-paulo",
    country: "BR",
    zone: "sao-paulo",
    displayName: "São Paulo",
    boundingBox: { swLat: -23.911, swLng: -46.984, neLat: -23.195, neLng: -46.185 },
    defaultMapCenter: { lat: -23.5505, lng: -46.6333 }, // Sé/Centro
    timezone: "America/Sao_Paulo",
    locale: "pt-BR",
    modes: {
      bus: {
        // SPTrans Olho Vivo tiene RT pero requiere registro gratuito
        // (token por email → POST /Login/Autenticar → cookie L-Session).
        // Por ahora staticOnly con GTFS público vía Mobility Database.
        // Cuando se registre el token y se sume adapter `sptrans-rt`, pasa
        // a `official` con feed configurado.
        dataMode: "staticOnly",
      },
    },
  },

  // ===========================================================================
  // COLOMBIA
  // ===========================================================================
  {
    id: "co.bogota",
    country: "CO",
    zone: "bogota",
    displayName: "Bogotá D.C.",
    // Distrito Capital + sabana cercana (Soacha, Chía, Cota)
    boundingBox: { swLat: 4.40, swLng: -74.30, neLat: 4.85, neLng: -73.95 },
    defaultMapCenter: { lat: 4.6097, lng: -74.0817 }, // Plaza Bolívar
    timezone: "America/Bogota",
    locale: "es-CO",
    modes: {
      bus: {
        // TransMilenio publica GTFS-RT VehiclePositions estándar
        // (`https://gtfs.transmilenio.gov.co/positions.pb`, refresh 15s).
        // Validado 2026-04-27 — endpoint vivo, parseable con
        // `gtfs-realtime-bindings`. Estático también disponible (156MB).
        dataMode: "official",
        feed: "transmilenio-positions",
      },
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
