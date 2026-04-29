/**
 * Catálogo de Operators (organismos que aportan datos a Vamo).
 *
 * Un Operator es la entidad que publica un feed (RT o estático). Una jurisdicción
 * puede tener varios operators contribuyendo (ej. Mvd recibe datos de IMM urbano
 * + MTOP interdepartamental). Un mismo operator puede dar datos a varias
 * jurisdicciones (ej. CRTM cubre Madrid metropolitano completo, no solo capital).
 *
 * Cada entry define:
 *   - id: identificador único snake-kebab (`imm`, `mtop`, `crtm`, etc.)
 *   - displayName: nombre humano (puede tener variantes locales en futuro)
 *   - country: ISO2 (donde tiene sede / opera principal)
 *   - kind: `public-agency` | `concession` | `private-operator` | `data-aggregator`
 *   - feeds: lista de feeds que publica (cada uno con mode + dataMode + adapter id)
 *   - color: paleta UI (alineada con feedback_vamo_company_colors.md)
 *   - license: atribución legal
 *   - contact: web oficial / soporte
 *
 * Para sumar operator nuevo:
 *   1. Agregar entry acá
 *   2. Asegurar que cada feed.adapterId está en `lib/adapters/registry.js`
 *   3. Asociar a 1+ jurisdicciones/metroAreas/nationalNetworks vía `coverage`
 */

const OPERATORS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "imm",
    displayName: "IMM — Intendencia de Montevideo",
    country: "UY",
    kind: "public-agency",
    color: { palette: "stm", reservedFor: "official" },
    license: "Datos abiertos Intendencia de Montevideo (CC BY 4.0)",
    contact: "https://montevideo.gub.uy/",
    feeds: [
      // Bus urbano: STM (Sistema de Transporte Metropolitano) — feed live OAuth.
      // STM urbano NO se queda en Mvd capital: muchas líneas ingresan a
      // Canelones (D9 a Pando, G a Las Piedras, 711 a Ciudad de la Costa,
      // 710/711 Costa de Oro, Toledo, Barros Blancos) y San José (líneas a
      // Libertad). Por eso cubre el metroArea completo (sin override propio).
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "imm-stm" },
      // Bus suburbano: mismo backend STM filtrado a empresas suburbanas
      // (COPSA / CITA / CASANOVA / COIT / SAN ANTONIO / ZEBALLOS / RUTAS DEL NORTE).
      // Sin coverage propio: usa el del operator (cubre metroArea completo).
      { mode: "bus", service: "suburban", dataMode: "official", adapterId: "imm-stm-suburban" },
    ],
    coverage: {
      jurisdictions: ["uy.mvd"],
      metroAreas: ["uy.mvd-area-metro"], // suburbano sirve al area metro completa
    },
  },
  {
    id: "mtop",
    displayName: "MTOP — Ministerio de Transporte y Obras Públicas",
    country: "UY",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "MTOP DNT — Datos abiertos Catálogo Nacional",
    contact: "https://www.gub.uy/ministerio-transporte-obras-publicas",
    feeds: [
      // GTFS estático nacional: cubre Mvd + Canelones + San José + interdepartamental.
      // Sin RT — paradas + horarios + recorridos (KML aux para shapes).
      { mode: "bus", service: "suburban", dataMode: "staticOnly", adapterId: null, staticFeedId: "mtop-suburban-static" },
      { mode: "bus", service: "long-distance", dataMode: "staticOnly", adapterId: null, staticFeedId: "mtop-suburban-static" },
    ],
    coverage: {
      jurisdictions: ["uy.mvd", "uy.canelones", "uy.san-jose"],
      metroAreas: ["uy.mvd-area-metro"],
      nationalNetworks: ["uy.long-distance"],
    },
  },
  {
    id: "codesa",
    displayName: "CODESA — Compañía del Este",
    country: "UY",
    kind: "concession",
    color: { palette: "gray", reservedFor: "company" },
    license: "CODESA + Google MyMaps (uso público)",
    contact: "https://www.codesa.com.uy/",
    feeds: [
      // RT: Busmatick AVL XML (sin auth, refresh 15s)
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "codesa-avl" },
      // Estático: snapshot sintético construido scrapeando MyMaps de codesa.com.uy
      { mode: "bus", service: "urban", dataMode: "official", adapterId: null, staticFeedId: "codesa-mymaps-static" },
    ],
    coverage: {
      jurisdictions: ["uy.maldonado"],
    },
  },

  // ===========================================================================
  // ARGENTINA
  // ===========================================================================
  {
    id: "gcba",
    displayName: "GCBA — Gobierno de la Ciudad de Buenos Aires",
    country: "AR",
    kind: "public-agency",
    color: { palette: "yellow", reservedFor: "official" },
    license: "Datos abiertos GCBA",
    contact: "https://buenosaires.gob.ar/",
    feeds: [
      // Bus colectivos: JSON enriquecido AMBA (CABA + 24 partidos GBA).
      // Sin coverage propio: usa el del operator (AMBA completo).
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "gcba-vehicles-simple" },
      // Subte: forecast JSON custom (sin GPS — predicciones de arribo). Pendiente.
      // Coverage propio: solo CABA (subte no llega a GBA).
      {
        mode: "subte", service: "urban", dataMode: "official", adapterId: "gcba-subte-forecast",
        coverage: { jurisdictions: ["ar.caba"] },
      },
      // Ecobici GBFS: docking stations (no `TransitVehicle` — modelo BikeStation pendiente).
      // Coverage propio: solo CABA (Ecobici opera dentro de la capital).
      {
        mode: "bike", service: "urban", dataMode: "official", adapterId: "gcba-ecobici-gbfs",
        coverage: { jurisdictions: ["ar.caba"] },
      },
    ],
    coverage: {
      jurisdictions: ["ar.caba", "ar.gba"],
      metroAreas: ["ar.amba"],
    },
  },

  // ===========================================================================
  // PORTUGAL
  // ===========================================================================
  {
    id: "cm-lisboa",
    displayName: "Carris Metropolitana de Lisboa",
    country: "PT",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "company" },
    license: "Carris Metropolitana — API pública",
    contact: "https://www.carrismetropolitana.pt/",
    feeds: [
      // RT: JSON v2 enriquecido (sin auth)
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "cm-lisboa-vehicles" },
      // Estático: GTFS público
      { mode: "bus", service: "urban", dataMode: "official", adapterId: null, staticFeedId: "cm-lisboa-static" },
    ],
    coverage: {
      jurisdictions: ["pt.lisboa"],
      metroAreas: ["pt.lisboa-area-metro"],
    },
  },

  // ===========================================================================
  // ESPAÑA
  // ===========================================================================
  {
    id: "crtm",
    displayName: "CRTM — Consorcio Regional de Transportes de Madrid",
    country: "ES",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "CRTM — Datos abiertos Consorcio Regional",
    contact: "https://www.crtm.es/",
    feeds: [
      // Estático ArcGIS Feature Service (4.969 paradas EMT + 472 shapes)
      { mode: "bus", service: "urban", dataMode: "staticOnly", adapterId: null, staticFeedId: "crtm-madrid-emt-static" },
    ],
    coverage: {
      jurisdictions: ["es.madrid"],
      metroAreas: ["es.madrid-area-metro"],
    },
  },
  {
    id: "emt-madrid",
    displayName: "EMT Madrid — Empresa Municipal de Transportes",
    country: "ES",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "company" },
    license: "EMT Madrid — pendiente registro OAuth",
    contact: "https://www.emtmadrid.es/",
    feeds: [
      // RT: requiere OAuth registration (externo del user). Pendiente.
      { mode: "bus", service: "urban", dataMode: "communityOnly", adapterId: null, note: "OAuth pendiente" },
    ],
    coverage: {
      jurisdictions: ["es.madrid"],
    },
  },
  {
    id: "tmb",
    displayName: "TMB — Transports Metropolitans de Barcelona",
    country: "ES",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "company" },
    license: "TMB — pendiente registro OAuth",
    contact: "https://www.tmb.cat/",
    feeds: [
      { mode: "bus", service: "urban", dataMode: "communityOnly", adapterId: null, note: "OAuth pendiente" },
      { mode: "subte", service: "urban", dataMode: "communityOnly", adapterId: null, note: "OAuth pendiente" },
    ],
    coverage: {
      jurisdictions: ["es.barcelona"],
      metroAreas: ["es.barcelona-area-metro"],
    },
  },
  {
    id: "renfe",
    displayName: "Renfe Operadora",
    country: "ES",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "Renfe — Datos abiertos data.renfe.com",
    contact: "https://www.renfe.com/",
    feeds: [
      // RT Larga Distancia: GTFS-RT JSON nacional (211+ trenes hora pico)
      { mode: "tren", service: "long-distance", dataMode: "official", adapterId: "renfe-largadistancia-json" },
      // Estático LD/MD: complementa RT con paradas + horarios + recorridos (~760 KB)
      { mode: "tren", service: "long-distance", dataMode: "official", adapterId: null, staticFeedId: "renfe-largadistancia-static" },
      // Cercanías Madrid + Rodalies Barcelona: GTFS estático nacional (~15 MB).
      // URL confirmada 2026-04-27 (data.renfe.com/dataset/horarios-cercanias).
      { mode: "tren", service: "cercanias", dataMode: "staticOnly", adapterId: null, staticFeedId: "renfe-cercanias-static" },
      { mode: "tren", service: "rodalies", dataMode: "staticOnly", adapterId: null, staticFeedId: "renfe-cercanias-static" },
    ],
    coverage: {
      jurisdictions: ["es.madrid", "es.barcelona"],
      metroAreas: ["es.madrid-area-metro", "es.barcelona-area-metro"],
      nationalNetworks: ["es.larga-distancia"],
    },
  },

  // ===========================================================================
  // BRASIL
  // ===========================================================================
  {
    id: "sptrans",
    displayName: "SPTrans — São Paulo Transporte",
    country: "BR",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "SPTrans — GTFS público vía Mobility Database",
    contact: "https://www.sptrans.com.br/",
    feeds: [
      // RT: Olho Vivo requiere registro gratuito (token por email). Pendiente.
      // Estático: GTFS público (22k stops + 1.3k routes)
      { mode: "bus", service: "urban", dataMode: "staticOnly", adapterId: null, staticFeedId: "sptrans-static" },
    ],
    coverage: {
      jurisdictions: ["br.sao-paulo"],
    },
  },

  // ===========================================================================
  // FINLANDIA
  // ===========================================================================
  {
    id: "hsl-helsinki",
    displayName: "HSL — Helsingin seudun liikenne",
    country: "FI",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "HSL Open Data CC BY 4.0",
    contact: "https://www.hsl.fi/en/hsl/open-data",
    feeds: [
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "hsl-helsinki-vp" },
      { mode: "subte", service: "urban", dataMode: "official", adapterId: "hsl-helsinki-vp" },
      { mode: "tren", service: "commuter", dataMode: "official", adapterId: "hsl-helsinki-vp" },
      { mode: "ferry", service: "urban", dataMode: "official", adapterId: "hsl-helsinki-vp" },
    ],
    coverage: { jurisdictions: ["fi.helsinki"] },
  },

  // ===========================================================================
  // ESTADOS UNIDOS
  // ===========================================================================
  {
    id: "metrotransit-minneapolis",
    displayName: "Metro Transit — Twin Cities",
    country: "US",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "Metro Transit Open Data (free)",
    contact: "https://www.metrotransit.org/developer",
    feeds: [
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "metrotransit-minneapolis-vp" },
      { mode: "tren", service: "light-rail", dataMode: "official", adapterId: "metrotransit-minneapolis-vp" },
      { mode: "tren", service: "commuter", dataMode: "official", adapterId: "metrotransit-minneapolis-vp" },
    ],
    coverage: { jurisdictions: ["us.minneapolis"] },
  },

  // ===========================================================================
  // PAÍSES BAJOS — agregador nacional
  // ===========================================================================
  {
    id: "ovapi-netherlands",
    displayName: "OVapi / NDOV — agregador nacional Holanda",
    country: "NL",
    kind: "aggregator",
    color: { palette: "gray", reservedFor: "official" },
    license: "CC BY 4.0",
    contact: "https://ovapi.nl/",
    feeds: [
      // OVapi feed agrega NS (trenes), GVB Amsterdam, RET Rotterdam, HTM La Haya,
      // Connexxion, Arriva, Qbuzz. tripUpdates.pb es el endpoint principal.
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "ovapi-netherlands-vp" },
      { mode: "subte", service: "urban", dataMode: "official", adapterId: "ovapi-netherlands-vp" },
      { mode: "tren", service: "intercity", dataMode: "official", adapterId: "ovapi-netherlands-vp" },
      { mode: "ferry", service: "urban", dataMode: "official", adapterId: "ovapi-netherlands-vp" },
    ],
    coverage: { nationalNetworks: ["nl.netherlands"] },
  },

  // ===========================================================================
  // AUSTRALIA
  // ===========================================================================
  {
    id: "translink-brisbane",
    displayName: "TransLink Queensland",
    country: "AU",
    kind: "public-agency",
    color: { palette: "gray", reservedFor: "official" },
    license: "CC BY 4.0",
    contact: "https://translink.com.au/about-translink/open-data",
    feeds: [
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "translink-brisbane-vp" },
      { mode: "tren", service: "commuter", dataMode: "official", adapterId: "translink-brisbane-vp" },
      { mode: "ferry", service: "urban", dataMode: "official", adapterId: "translink-brisbane-vp" },
      { mode: "tren", service: "light-rail", dataMode: "official", adapterId: "translink-brisbane-vp" },
    ],
    coverage: { jurisdictions: ["au.brisbane"] },
  },

  // ===========================================================================
  // COLOMBIA
  // ===========================================================================
  {
    id: "transmilenio",
    displayName: "TransMilenio S.A.",
    country: "CO",
    kind: "public-agency",
    color: { palette: "red", reservedFor: "official" },
    license: "TransMilenio — Datos abiertos datos.gov.co",
    contact: "https://www.transmilenio.gov.co/",
    feeds: [
      // RT: GTFS-RT VehiclePositions estándar protobuf (refresh 15s)
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "transmilenio-positions" },
      // Estático: GTFS 156MB (8k stops + 1k routes + 1k shapes)
      { mode: "bus", service: "urban", dataMode: "official", adapterId: null, staticFeedId: "transmilenio-bogota-static" },
    ],
    coverage: {
      jurisdictions: ["co.bogota"],
    },
  },
];

const OPERATORS_BY_ID = Object.fromEntries(OPERATORS.map((o) => [o.id, o]));

/**
 * Devuelve los operators que cubren una jurisdicción dada.
 * Buscar por: jurisdictions[] directa, metroAreas[] (si la juris es parte
 * de un metroArea cubierto), o nationalNetworks[] (si la juris está en la red).
 *
 * @param {string} jurisdictionId
 * @param {object} opts - { metroAreas: [...], nationalNetworks: [...] } para
 *   resolver coverage indirecto. Si no se pasan, solo busca matches directos.
 */
function getOperatorsForJurisdiction(jurisdictionId, opts = {}) {
  const { metroAreas = [], nationalNetworks = [] } = opts;
  return OPERATORS.filter((o) => {
    if (o.coverage.jurisdictions?.includes(jurisdictionId)) return true;
    if (metroAreas.some((ma) => o.coverage.metroAreas?.includes(ma))) return true;
    if (nationalNetworks.some((nn) => o.coverage.nationalNetworks?.includes(nn))) return true;
    return false;
  });
}

/**
 * Devuelve los feeds disponibles para (jurisdiction, mode, service?) cruzando
 * todos los operators que la cubren.
 */
function getFeedsForJurisdictionMode(jurisdictionId, mode, service, opts = {}) {
  const ops = getOperatorsForJurisdiction(jurisdictionId, opts);
  const out = [];
  for (const op of ops) {
    for (const feed of op.feeds) {
      if (feed.mode !== mode) continue;
      if (service && feed.service !== service) continue;
      out.push({ operatorId: op.id, ...feed });
    }
  }
  return out;
}

module.exports = {
  OPERATORS,
  OPERATORS_BY_ID,
  getOperatorsForJurisdiction,
  getFeedsForJurisdictionMode,
};
