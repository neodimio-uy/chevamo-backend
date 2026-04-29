/**
 * Catálogo de feeds GTFS estáticos (paradas / rutas / shapes / calendario).
 *
 * GTFS estático ≠ GTFS-Realtime. Estos feeds son fotos del sistema (paradas,
 * recorridos, frecuencias) que se publican con baja frecuencia (semanal-mensual).
 * Vamo los necesita para:
 *   - Mostrar paradas en el mapa cuando NO hay feed RT
 *   - Lookups de `route_short_name` / `headsign` desde un trip_id en RT
 *   - Shapes (polyline) para dibujar líneas
 *   - Calendario de servicio (qué días corre cada trip)
 *
 * Cada entry define:
 *   - feedId: identificador único, ej `imm-stm-static`, `cm-lisboa-static`
 *   - cityIds: array de cityIds de `lib/cities.js` que cubre este feed
 *     (un mismo GTFS puede cubrir varias ciudades — ej MTOP suburbano cubre Mvd+Canelones+SJ)
 *   - sourceUrl: URL pública del ZIP GTFS (descarga directa)
 *   - bbox: { swLat, swLng, neLat, neLng } — filtro geográfico, descarta paradas fuera
 *     (importante para feeds nacionales tipo NSSA Argentina entera)
 *   - refreshIntervalDays: cada cuántos días re-descargar
 *   - license: SPDX o texto libre (para atribución)
 *   - notes: comentarios de auditoría
 *
 * NO confundir con `lib/cities.js` (ese mantiene RT feeds + dataMode por modo).
 * Este registry es complementario: mismo cityId puede tener feed RT (real-time) +
 * feed static (catálogo).
 *
 * Sumar feed:
 *   1. Conseguir URL pública de ZIP GTFS (verificar con HEAD que existe)
 *   2. Determinar bbox (usualmente coincide con bbox de la(s) ciudad(es) cubiertas)
 *   3. Agregar entry acá
 *   4. Correr pipeline con `runStaticGtfsPipeline?feedId=<id>` para validar
 */

const STATIC_FEEDS = [
  {
    feedId:              "cm-lisboa-static",
    cityIds:             ["pt.lisboa-area-metro"],
    sourceUrl:           "https://api.carrismetropolitana.pt/v2/gtfs",
    bbox:                { swLat: 38.50, swLng: -9.55, neLat: 39.10, neLng: -8.70 },
    refreshIntervalDays: 7,
    license:             "Carris Metropolitana — uso libre con atribución",
    notes:               "ZIP ~100MB. Cubre 4 agencias (41/42/43/44), 714 líneas, 12.702 paradas. Validado live 2026-04-26.",
  },
  {
    feedId:              "transmilenio-bogota-static",
    cityIds:             ["co.bogota"],
    sourceUrl:           "https://gtfs.transmilenio.gov.co/GTFS.zip",
    bbox:                { swLat: 4.40, swLng: -74.30, neLat: 4.85, neLng: -73.95 },
    refreshIntervalDays: 7,
    license:             "TransMilenio S.A. — Datos abiertos Colombia",
    notes:               "ZIP ~156MB (más grande que Lisboa). Validado live 2026-04-27. Cubre TransMilenio + alimentadores SITP + zonas integradas. RT VehiclePositions cada 15s en `positions.pb`.",
  },
  {
    feedId:              "sptrans-static",
    cityIds:             ["br.sao-paulo"],
    sourceUrl:           "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/br-sao-paulo-sao-paulo-transporte-sptrans-gtfs-8.zip?alt=media",
    bbox:                { swLat: -23.911, swLng: -46.984, neLat: -23.195, neLng: -46.185 },
    refreshIntervalDays: 14,
    license:             "SPTrans — Mobility Database mirror",
    notes:               "Mirror público en Mobility Database (mdb-latest). Original requiere auth (registro gratuito en sptrans.com.br/desenvolvedores). MDB descarga y publica el último automáticamente. ZIP ~14MB.",
  },
  {
    feedId:              "gcba-colectivos-static",
    cityIds:             ["ar.amba"],
    sourceUrl:           "https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/colectivos-gtfs/colectivos-gtfs.zip",
    bbox:                { swLat: -35.30, swLng: -59.00, neLat: -34.30, neLng: -57.70 },
    refreshIntervalDays: 14,
    license:             "GCBA — Datos Abiertos Buenos Aires",
    notes:               "GTFS estático colectivos CABA. Cubre solo CABA (no AMBA entera — provincia BsAs requiere otros feeds). Complementa el feed RT `gcba-vehicles-simple` que sí cubre AMBA.",
  },
  {
    feedId:              "mtop-suburban-static",
    cityIds:             ["uy.mvd-area-metro", "uy.long-distance"],
    sourceUrl:           "https://catalogodatos.gub.uy/dataset/1d50ccf7-121d-48a7-951e-28a02858d24e/resource/9f44b654-751a-42a4-a481-af91b7c9a2e4/download",
    // KML auxiliar con los recorridos (MTOP no incluye shapes.txt en su GTFS).
    // El pipeline lo descarga, parsea y mergea — los shapes resultantes se
    // matchean con trips por `route_id == Variante` (1-a-1 en MTOP).
    shapesKmlUrl:        "https://catalogodatos.gub.uy/dataset/3633b022-4fa8-4633-bf51-eb39f959ef8b/resource/ffc2dc6a-7ee6-4109-93d6-e45a5b0ea3a8/download/recorridos_metropolitanos.kml",
    kmlShapeIdField:     "Variante",
    bbox:                { swLat: -35.10, swLng: -58.50, neLat: -32.50, neLng: -53.00 },
    refreshIntervalDays: 14,
    license:             "MTOP DNT Uruguay — Datos abiertos Catálogo Nacional",
    notes:               "ZIP ~2.7MB + KML 8.8MB. Cubre Mvd urbano + suburbano (Canelones + San José + interdepartamental). 7,190 paradas + 619 recorridos + horarios.",
  },
  {
    feedId:        "crtm-madrid-emt-static",
    cityIds:       ["es.madrid-area-metro"],
    customBuilder: "crtm-madrid-emt",
    bbox:          { swLat: 40.20, swLng: -4.20, neLat: 40.70, neLng: -3.40 },
    refreshIntervalDays: 14,
    license:       "CRTM Madrid — Datos abiertos Consorcio Regional de Transportes",
    notes:         "ArcGIS Feature Service M6_Red — 4.969 estaciones EMT (paradas) + 11.504 tramos (polylines). Builder agrupa tramos en shapes por (NUMEROLINEAUSUARIO, SENTIDO). Solo cubre EMT urbano de Madrid (no metro, no Cercanías Renfe — esos requieren feeds CRTM aparte).",
  },
  {
    feedId:              "renfe-cercanias-static",
    cityIds:             ["es.madrid-area-metro", "es.barcelona-area-metro"],
    sourceUrl:           "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip",
    bbox:                { swLat: 35.50, swLng: -9.50, neLat: 44.00, neLng: 4.50 },
    refreshIntervalDays: 7,
    license:             "Renfe — Creative Commons Attribution 4.0 (data.renfe.com)",
    notes:               "GTFS estático nacional Cercanías + Rodalies. ~15 MB. Cubre Madrid, Barcelona, Valencia, Sevilla, Bilbao, Asturias, Cádiz, Málaga, Murcia, San Sebastián. URL confirmada 2026-04-27 (data.renfe.com/dataset/horarios-cercanias).",
  },
  {
    feedId:              "renfe-largadistancia-static",
    cityIds:             ["es.larga-distancia"],
    sourceUrl:           "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip",
    bbox:                { swLat: 35.50, swLng: -9.50, neLat: 44.00, neLng: 4.50 },
    refreshIntervalDays: 7,
    license:             "Renfe — Creative Commons Attribution 4.0 (data.renfe.com)",
    notes:               "GTFS estático Alta Velocidad + Larga Distancia + Media Distancia (excluye Cercanías/FEVE). ~760 KB. Complementa el feed RT `renfe-largadistancia-json` con paradas + horarios + recorridos. URL confirmada 2026-04-27.",
  },
  {
    feedId:        "codesa-mymaps-static",
    cityIds:       ["uy.maldonado"],
    // No hay sourceUrl ZIP — el adapter custom descarga ~40 KMLs de Google
    // MyMaps y construye el snapshot sintético con routes + shapes + stops.
    customBuilder: "codesa-mymaps",
    bbox:          { swLat: -35.10, swLng: -55.20, neLat: -34.50, neLng: -54.20 },
    refreshIntervalDays: 30,
    license:       "CODESA + Google MyMaps (uso público)",
    notes:         "22 líneas (40 mids ida/vuelta) descubiertas vía scraping de codesa.com.uy/p/linea-*.html. Cada MyMaps trae LineStrings (recorrido) + Points (paradas/referencias). El adapter filtra referencias y dedupea paradas por (coord, nombre).",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Pendientes de validar URL pública (placeholders activables — comentados
  // hasta confirmar). Cuando se confirmen, mover fuera del bloque comentado.
  // ─────────────────────────────────────────────────────────────────────
  //
  // imm-stm-static (Mvd urbano): GTFS local en /Users/ignacio/mvd-proxy/gtfs/
  // desde 2026-04-05. URL pública pendiente con IMM.
  //   sourceUrl: "https://... (pendiente)"
  //   bbox:      { swLat: -34.95, swLng: -56.50, neLat: -34.40, neLng: -55.80 }
  //
  // mtop-suburban-static (UY suburbano): GTFS oficial MTOP cubre Mvd+Canelones+SJ.
  // 7,190 paradas + 368 shapes confirmados (2026-04-22, ver project_vamo_mtop_suburban_data.md).
  // URL en datos.gub.uy pendiente verificar.
  //
  // mtop-longdistance-static (UY larga distancia): mismo origen MTOP, paradas
  // y horarios interdepartamentales.
  //
  // crtm-madrid-static (Madrid bus + cercanías): Consorcio Regional de Transportes
  // de Madrid publica GTFS en datos.gob.es. URL típica:
  //   https://datos.crtm.es/.../gtfs.zip
  //
  // renfe-cercanias-static (Renfe Cercanías Madrid + Barcelona Rodalies): GTFS
  // público en datos.gob.es. Cubre toda España, filtrar por bbox por ciudad.
  //
  // transmilenio-bogota-static (Bogotá): TransMilenio publica GTFS en datos.gov.co.
  //   sourceUrl candidata: "https://datosabiertos-transmilenio-cl.opendata.arcgis.com/.../gtfs.zip"
  //
  // tmb-barcelona-static (Barcelona TMB): GTFS via API TMB con OAuth.
];

const STATIC_FEEDS_BY_ID = Object.fromEntries(STATIC_FEEDS.map((f) => [f.feedId, f]));

function getStaticFeed(feedId) {
  return STATIC_FEEDS_BY_ID[feedId] || null;
}

module.exports = { STATIC_FEEDS, STATIC_FEEDS_BY_ID, getStaticFeed };
