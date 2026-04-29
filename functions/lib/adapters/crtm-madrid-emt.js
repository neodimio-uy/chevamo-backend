/**
 * Builder de snapshot para CRTM Madrid EMT (autobuses urbanos).
 *
 * CRTM publica los datos vía ArcGIS Feature Service en
 * `services5.arcgis.com/UxADft6QPcvFyDU1/.../M6_Red/FeatureServer`. NO es
 * GTFS — es un schema propio del Consorcio Regional de Transportes de
 * Madrid con 4 capas (estaciones, postes, tramos, paradas-por-itinerario).
 *
 * Este builder mapea:
 *   - Layer 0 (M6_Estaciones, 4.969 puntos) → `stops.txt`
 *   - Layer 2 (M6_Tramos, 11.504 polylines) → `shapes.txt` agrupando por
 *     `(NUMEROLINEAUSUARIO, SENTIDO)` → un shape por línea-y-sentido
 *   - `routes.txt` derivado de los NUMEROLINEAUSUARIO únicos
 *   - `agency.txt` = EMT Madrid (stub) — CRTM agrupa varias empresas pero
 *     el item explícito es "Autobuses Urbanos de Madrid: EMT"
 *   - Layer 1 (Postes) y Layer 3 (ParadasPorItinerario) se ignoran por ahora —
 *     postes son posiciones físicas que duplican estaciones, y la relación
 *     itinerario↔parada no aporta sin un schema GTFS-trips completo.
 *
 * Paginación: ArcGIS limita query a 2.000 features por request → paginamos
 * con `resultOffset` + `resultRecordCount=2000`. Total 4 + 6 = 10 requests
 * para cubrir todo, ejecutadas en paralelo con concurrency 4.
 */

const axios = require("axios");

const SERVICE_URL = "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M6_Red/FeatureServer";
const PAGE_SIZE = 2000;

/**
 * Cuenta total de features de un layer.
 */
async function fetchCount(layerId) {
  const url = `${SERVICE_URL}/${layerId}/query?where=1%3D1&returnCountOnly=true&f=json`;
  const r = await axios.get(url, { timeout: 20_000 });
  return r.data?.count || 0;
}

/**
 * Pagina sobre un layer y devuelve todas las features (geometry + attributes).
 * outSR=4326 convierte a WGS84 (lat/lng) — el default del service es metros.
 */
async function fetchAllFeatures(layerId, count) {
  const pages = Math.ceil(count / PAGE_SIZE);
  const offsets = Array.from({ length: pages }, (_, i) => i * PAGE_SIZE);
  const results = await mapWithConcurrency(offsets, 4, async (offset) => {
    const url = `${SERVICE_URL}/${layerId}/query`
      + `?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326`
      + `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}&f=json`;
    const r = await axios.get(url, { timeout: 30_000 });
    return r.data?.features || [];
  });
  return results.flat();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Builder: ejecuta queries en paralelo, mapea al StaticCatalog canónico.
 */
async function buildSnapshot({ feedConfig }) {
  // Counts en paralelo
  const [stopsCount, tramosCount] = await Promise.all([
    fetchCount(0), // M6_Estaciones
    fetchCount(2), // M6_Tramos
  ]);

  // Fetch en paralelo (10+ requests pero rápido)
  const [stopsFeatures, tramosFeatures] = await Promise.all([
    fetchAllFeatures(0, stopsCount),
    fetchAllFeatures(2, tramosCount),
  ]);

  // ─────────────────────────────────────────────────────────────────────
  // Stops (Layer 0 — M6_Estaciones)
  // ─────────────────────────────────────────────────────────────────────
  const stops = [];
  const seenStopIds = new Set();
  for (const f of stopsFeatures) {
    const a = f.attributes || {};
    const g = f.geometry || {};
    const lng = typeof g.x === "number" ? g.x : Number(a.X);
    const lat = typeof g.y === "number" ? g.y : Number(a.Y);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const stopId = String(a.CODIGOESTACION || a.IDESTACION || a.OBJECTID || "");
    if (!stopId || seenStopIds.has(stopId)) continue;
    seenStopIds.add(stopId);

    stops.push({
      stop_id:        stopId,
      stop_code:      a.CODIGOESTACION ? String(a.CODIGOESTACION) : null,
      stop_name:      String(a.DENOMINACION || a.DENOMINACIONABREVIADA || `Parada ${stopId}`),
      stop_lat:       lat,
      stop_lon:       lng,
      location_type:  0,
      parent_station: null,
      wheelchair_boarding: a.GRADOACCESIBILIDAD === "1" ? 1 : null,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Routes y Shapes (Layer 2 — M6_Tramos agrupados por línea+sentido)
  // ─────────────────────────────────────────────────────────────────────
  // Cada Tramo es un sub-segmento (estación A → estación B). Para construir
  // el shape de una línea, concatenamos los tramos en orden por NUMEROORDEN
  // dentro de cada (NUMEROLINEAUSUARIO, SENTIDO).
  const tramosByRouteSentido = new Map(); // key: "{linea}|{sentido}" → tramos[]

  for (const f of tramosFeatures) {
    const a = f.attributes || {};
    const g = f.geometry || {};
    const linea = String(a.NUMEROLINEAUSUARIO || a.CODIGOGESTIONLINEA || "");
    if (!linea) continue;
    const sentido = a.SENTIDO ? String(a.SENTIDO) : "1";
    const orden = Number(a.NUMEROORDEN) || 0;

    // ArcGIS polyline: paths = [[[lng,lat], [lng,lat], ...]]
    if (!Array.isArray(g.paths) || g.paths.length === 0) continue;

    const key = `${linea}|${sentido}`;
    if (!tramosByRouteSentido.has(key)) tramosByRouteSentido.set(key, []);
    tramosByRouteSentido.get(key).push({ orden, paths: g.paths });
  }

  const shapes = [];
  const seenRoutes = new Set();
  const routes = [];

  for (const [key, tramos] of tramosByRouteSentido) {
    const [linea, sentido] = key.split("|");

    // Acumular routes únicos
    if (!seenRoutes.has(linea)) {
      seenRoutes.add(linea);
      routes.push({
        route_id:         linea,
        agency_id:        "EMT",
        route_short_name: linea,
        route_long_name:  null,
        route_type:       3, // bus
        route_color:      null,
        route_text_color: null,
      });
    }

    // Ordenar tramos por NUMEROORDEN y concatenar paths
    tramos.sort((a, b) => a.orden - b.orden);
    const concatenated = [];
    for (const t of tramos) {
      for (const path of t.paths) {
        for (const pt of path) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const lng = Number(pt[0]);
          const lat = Number(pt[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          // Dedup contiguos: si el último punto es igual al actual, skip.
          // Ahorra ~30% del tamaño en feeds donde tramos comparten nodos.
          const last = concatenated[concatenated.length - 1];
          if (!last || last[0] !== lat || last[1] !== lng) {
            concatenated.push([lat, lng]);
          }
        }
      }
    }
    if (concatenated.length >= 2) {
      shapes.push({
        shape_id: `${linea}_${sentido}`,
        points:   concatenated,
        route_id: linea,
        sentido,
      });
    }
  }

  return {
    feedId:     feedConfig.feedId,
    sourceUrl:  SERVICE_URL,
    cityIds:    feedConfig.cityIds,
    bbox:       feedConfig.bbox,
    license:    feedConfig.license,
    generatedAt: new Date().toISOString(),
    counts: {
      stops:         stops.length,
      routes:        routes.length,
      trips:         0,
      shapes:        shapes.length,
      calendar:      0,
      calendarDates: 0,
      agency:        1,
      droppedStops:  stopsFeatures.length - stops.length,
      droppedTrips:  0,
    },
    stops,
    routes,
    trips: [],
    shapes,
    calendar: [],
    calendarDates: [],
    agency: [{
      agency_id:       "EMT",
      agency_name:     "EMT Madrid (Empresa Municipal de Transportes)",
      agency_url:      "https://www.emtmadrid.es",
      agency_timezone: "Europe/Madrid",
      agency_lang:     "es",
    }],
    feedInfo: [{
      feed_publisher_name: "Vamo / CRTM ArcGIS converter",
      feed_publisher_url:  "https://datos.crtm.es",
      feed_lang:           "es",
      feed_version:        new Date().toISOString().slice(0, 10),
    }],
  };
}

module.exports = { buildSnapshot };
