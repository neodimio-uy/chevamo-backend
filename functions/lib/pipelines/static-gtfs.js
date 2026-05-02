/**
 * Pipeline para GTFS estático: descarga ZIP, parsea CSVs, filtra por bbox,
 * cascada filtra trips/shapes que dependen de stops/routes filtradas, devuelve
 * snapshot estructurado.
 *
 * Diseño:
 *   1. fetchZip(url) → Buffer
 *   2. extractToTmp(buffer, feedId) → /tmp/{feedId}/*.txt
 *   3. parseAll(dir) → { stops, routes, trips, shapes, calendar, calendarDates,
 *      stopTimes, agency, feedInfo }  (cada uno array de objetos)
 *   4. filterByBbox(stops, bbox) → stops dentro del bbox
 *   5. cascadeFilter(parsed, keptStopIds) → solo routes/trips/shapes que
 *      tocan al menos una stop kept
 *   6. buildSnapshot(filtered) → output canónico (con counts + sampling)
 *
 * Importante: stop_times.txt es el archivo MÁS GRANDE (Mvd: 2.2M filas, ~150MB
 * descomprimido). Lo cargamos en streaming y descartamos rows tempranamente
 * cuando el trip_id no pertenece al set filtrado.
 *
 * Memory budget: con Lisboa GTFS (~100MB ZIP, ~600MB descomprimido) la function
 * necesita ~1GB de heap. Se setea en runtime config del Cloud Function.
 *
 * Output snapshot (escrito por separado a Cloud Storage por el caller):
 *   {
 *     feedId, sourceUrl, generatedAt,
 *     bbox: { ... },
 *     counts: { stops, routes, trips, shapes },
 *     stops: [...], routes: [...], trips: [...], shapes: [...] (compact format),
 *     calendar: [...], calendarDates: [...], agency: [...]
 *   }
 *
 * Shapes en formato compacto: { shape_id, points: [[lat, lng, dist_m?], ...] }
 * en vez de N rows por shape (ahorra ~80% de bytes).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { parse: parseCsv } = require("csv-parse/sync");
const { XMLParser } = require("fast-xml-parser");

// XML parser singleton para KML auxiliares (MTOP UY publica recorridos como
// KML separado del GTFS). Para que un Placemark con un solo Style/LineString
// se entregue como objeto en vez de array, dejamos el flag por defecto.
const kmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,  // mantener strings — los floats de Variante los normalizamos
  trimValues: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function tmpDirFor(feedId) {
  const dir = path.join(os.tmpdir(), `gtfs-${feedId}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmdirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Lee CSV con headers, retorna array de objetos. Lanza si el archivo no existe
 * o no es CSV válido. Para archivos opcionales el caller usa loadOptional.
 */
function loadCsv(filePath) {
  const buf = fs.readFileSync(filePath);
  // BOM strip (algunos GTFS portugueses traen BOM en feed_info.txt)
  const text = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
    ? buf.slice(3).toString("utf8")
    : buf.toString("utf8");
  return parseCsv(text, { columns: true, skip_empty_lines: true, trim: true });
}

function loadOptional(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return [];
  try { return loadCsv(p); } catch (_) { return []; }
}

function inBbox(lat, lng, bbox) {
  return lat >= bbox.swLat && lat <= bbox.neLat &&
         lng >= bbox.swLng && lng <= bbox.neLng;
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

async function fetchZip(url) {
  // User-Agent explícito: el proxy GCBA (apitransporte.buenosaires.gob.ar)
  // rechaza el default de axios. Otros publishers (datos abiertos GCBA,
  // Mobility Database) lo aceptan, así que es seguro por defecto.
  // Retry una vez con delay si 5xx — el proxy GCBA es flaky en cold-start
  // (memoria `project_vamo_ba.md`: 500 SSLHandshakeException intermitente).
  const reqOpts = {
    responseType:    "arraybuffer",
    timeout:         120_000,
    maxContentLength: 500 * 1024 * 1024,
    headers:         { "User-Agent": "Vamo/1.0" },
  };
  try {
    const r = await axios.get(url, reqOpts);
    return Buffer.from(r.data);
  } catch (e) {
    const status = e.response?.status;
    if (status && status >= 500 && status < 600) {
      await new Promise((res) => setTimeout(res, 2000));
      const r = await axios.get(url, reqOpts);
      return Buffer.from(r.data);
    }
    throw e;
  }
}

/**
 * Descarga + parsea un KML auxiliar de recorridos. Útil cuando el GTFS upstream
 * no incluye `shapes.txt` y el operador publica geometría de recorridos en KML
 * separado (caso MTOP UY suburbano). Devuelve `[{shape_id, points}]` listo
 * para mergear con `parsed.shapes`.
 *
 * Asume cada Placemark con `<ExtendedData><SchemaData>` que incluye un campo
 * que matchee el `route_id` del GTFS — para MTOP es `Variante`. El field se
 * pasa como `shapeIdField`.
 */
async function fetchAndParseKml(url, shapeIdField = "Variante") {
  const r = await axios.get(url, { responseType: "text", timeout: 60_000 });
  const xml = kmlParser.parse(r.data);

  // KML standard: kml.Document.Folder.Placemark[]  (sometimes nested deeper)
  // Busqueda recursiva del array de Placemarks.
  const placemarks = collectPlacemarks(xml);
  const shapes = [];

  for (const pm of placemarks) {
    const variante = extractSimpleData(pm, shapeIdField);
    if (!variante) continue;

    const coordsRaw = pm?.LineString?.coordinates || pm?.MultiGeometry?.LineString?.coordinates;
    if (!coordsRaw || typeof coordsRaw !== "string") continue;

    // KML coords: "lng,lat,alt lng,lat,alt ..." separadas por whitespace.
    // Normalizar y parsear.
    const points = [];
    const tokens = coordsRaw.trim().split(/\s+/);
    for (const t of tokens) {
      const parts = t.split(",");
      if (parts.length < 2) continue;
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      points.push([lat, lng]);
    }
    if (points.length < 2) continue;

    shapes.push({ shape_id: String(variante), points });
  }

  return shapes;
}

function collectPlacemarks(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectPlacemarks(n, acc);
    return acc;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === "Placemark") {
      if (Array.isArray(val)) acc.push(...val);
      else acc.push(val);
    } else if (typeof val === "object") {
      collectPlacemarks(val, acc);
    }
  }
  return acc;
}

/**
 * Extrae el valor de un SimpleData en ExtendedData.SchemaData. KML standard:
 *   <ExtendedData><SchemaData><SimpleData name="Variante">5003</SimpleData></SchemaData></ExtendedData>
 */
function extractSimpleData(placemark, fieldName) {
  const sd = placemark?.ExtendedData?.SchemaData?.SimpleData;
  if (!sd) return null;
  const arr = Array.isArray(sd) ? sd : [sd];
  for (const item of arr) {
    const name = item?.["@_name"];
    const value = item?.["#text"] ?? item;
    if (name === fieldName && value != null && value !== "") {
      return String(value).trim();
    }
  }
  return null;
}

function extractToTmp(zipBuffer, feedId) {
  const dir = tmpDirFor(feedId);
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(dir, /* overwrite */ true);
  return dir;
}

/**
 * Parsea todos los archivos GTFS conocidos. Retorna objetos con campos coerced
 * a tipos correctos donde aplica (lat/lng a number, etc).
 */
function parseAll(dir) {
  const stops = loadOptional(dir, "stops.txt").map((s) => ({
    stop_id:        s.stop_id,
    stop_code:      s.stop_code || null,
    stop_name:      s.stop_name || "",
    stop_lat:       Number(s.stop_lat),
    stop_lon:       Number(s.stop_lon),
    location_type:  s.location_type ? Number(s.location_type) : 0,
    parent_station: s.parent_station || null,
    wheelchair_boarding: s.wheelchair_boarding ? Number(s.wheelchair_boarding) : null,
  })).filter((s) => Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon));

  const routes = loadOptional(dir, "routes.txt").map((r) => ({
    route_id:         r.route_id,
    agency_id:        r.agency_id || null,
    route_short_name: r.route_short_name || null,
    route_long_name:  r.route_long_name || null,
    route_type:       r.route_type ? Number(r.route_type) : null,
    route_color:      r.route_color || null,
    route_text_color: r.route_text_color || null,
  }));

  const trips = loadOptional(dir, "trips.txt").map((t) => ({
    route_id:      t.route_id,
    service_id:    t.service_id,
    trip_id:       t.trip_id,
    trip_headsign: t.trip_headsign || null,
    direction_id:  t.direction_id ? Number(t.direction_id) : null,
    shape_id:      t.shape_id || null,
    block_id:      t.block_id || null,
  }));

  // Shapes: compactamos por shape_id en una sola entry con points ordenados
  const shapeRows = loadOptional(dir, "shapes.txt");
  const shapesMap = new Map();
  for (const row of shapeRows) {
    const id = row.shape_id;
    if (!id) continue;
    const lat = Number(row.shape_pt_lat);
    const lng = Number(row.shape_pt_lon);
    const seq = Number(row.shape_pt_sequence);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(seq)) continue;
    if (!shapesMap.has(id)) shapesMap.set(id, []);
    shapesMap.get(id).push([seq, lat, lng]);
  }
  const shapes = [];
  for (const [shape_id, pts] of shapesMap) {
    pts.sort((a, b) => a[0] - b[0]);
    shapes.push({ shape_id, points: pts.map(([_, lat, lng]) => [lat, lng]) });
  }

  const calendar = loadOptional(dir, "calendar.txt").map((c) => ({
    service_id: c.service_id,
    monday:     Number(c.monday) === 1,
    tuesday:    Number(c.tuesday) === 1,
    wednesday:  Number(c.wednesday) === 1,
    thursday:   Number(c.thursday) === 1,
    friday:     Number(c.friday) === 1,
    saturday:   Number(c.saturday) === 1,
    sunday:     Number(c.sunday) === 1,
    start_date: c.start_date,
    end_date:   c.end_date,
  }));

  const calendarDates = loadOptional(dir, "calendar_dates.txt").map((c) => ({
    service_id:     c.service_id,
    date:           c.date,
    exception_type: c.exception_type ? Number(c.exception_type) : null,
  }));

  const agency = loadOptional(dir, "agency.txt").map((a) => ({
    agency_id:       a.agency_id || null,
    agency_name:     a.agency_name || "",
    agency_url:      a.agency_url || null,
    agency_timezone: a.agency_timezone || null,
    agency_lang:     a.agency_lang || null,
  }));

  const feedInfo = loadOptional(dir, "feed_info.txt").map((f) => ({
    feed_publisher_name: f.feed_publisher_name || null,
    feed_publisher_url:  f.feed_publisher_url || null,
    feed_lang:           f.feed_lang || null,
    feed_start_date:     f.feed_start_date || null,
    feed_end_date:       f.feed_end_date || null,
    feed_version:        f.feed_version || null,
  }));

  return { stops, routes, trips, shapes, calendar, calendarDates, agency, feedInfo };
}

/**
 * Filtra stops por bbox y cascadea: queda solo lo que toca paradas dentro.
 *
 * Cascada:
 *   1. stops dentro del bbox
 *   2. para identificar trips relevantes necesitamos stop_times — pero parsearlo
 *      es caro (Mvd: 2.2M filas). Estrategia ligera: si NO hay stop_times.txt
 *      o el bbox cubre todo el feed, no filtramos trips/routes (asumimos que
 *      el feed ya está acotado al área).
 *   3. shapes asociados a los trips (vía shape_id)
 *   4. routes referenciadas por los trips
 *   5. calendar entries de los services usados
 *
 * Para esta primera versión usamos bbox para STOPS solamente y dejamos los
 * trips/routes/shapes/calendar enteros. El siguiente nivel es filtro por
 * stop_times (más caro pero más correcto). El callsite registra ambas counts.
 */
function filterByBbox(parsed, bbox) {
  const { stops, routes, trips, shapes, calendar, calendarDates, agency, feedInfo } = parsed;
  const stopsInBbox = stops.filter((s) => inBbox(s.stop_lat, s.stop_lon, bbox));

  // Cascada simple: routes/trips/shapes quedan tal cual. Si en el futuro
  // se agrega stopTimes parsing, acá entra el filtro por trip_id.
  return {
    stops:         stopsInBbox,
    routes,
    trips,
    shapes,
    calendar,
    calendarDates,
    agency,
    feedInfo,
    droppedStops: stops.length - stopsInBbox.length,
  };
}

/**
 * Filtro fuerte (opcional, costoso): usa stop_times.txt para descartar
 * trips/routes/shapes/calendars que no tocan ninguna stop dentro del bbox.
 *
 * Activar solo cuando el feed cubre área mucho mayor que el bbox (ej NSSA
 * Argentina entera filtrada a CABA, o MTOP UY filtrado a Mvd).
 *
 * NOTA: load streaming de stop_times — no llevarlo a memoria entera. Para
 * primer corte, lo cargamos en memoria; refactor a streaming si Cloud Function
 * pega OOM.
 */
function strongCascadeFilter(parsed, bboxFiltered, dir) {
  const stopTimesPath = path.join(dir, "stop_times.txt");
  if (!fs.existsSync(stopTimesPath)) {
    return bboxFiltered; // no hay stop_times, dejamos tal cual
  }

  const keptStopIds = new Set(bboxFiltered.stops.map((s) => s.stop_id));
  if (keptStopIds.size === 0) {
    // Bbox no agarró ninguna parada — retornamos vacío
    return {
      ...bboxFiltered,
      routes: [], trips: [], shapes: [], calendar: [], calendarDates: [], stopTimes: [],
    };
  }

  // stop_times completo (puede ser caro en memoria — Mvd 2.2M filas)
  const stopTimes = loadCsv(stopTimesPath);
  const tripIdsWithKeptStop = new Set();
  for (const st of stopTimes) {
    if (keptStopIds.has(st.stop_id)) {
      tripIdsWithKeptStop.add(st.trip_id);
    }
  }

  const trips = parsed.trips.filter((t) => tripIdsWithKeptStop.has(t.trip_id));
  const routeIds = new Set(trips.map((t) => t.route_id));
  const shapeIds = new Set(trips.map((t) => t.shape_id).filter(Boolean));
  const serviceIds = new Set(trips.map((t) => t.service_id));

  return {
    ...bboxFiltered,
    routes:        parsed.routes.filter((r) => routeIds.has(r.route_id)),
    trips,
    shapes:        parsed.shapes.filter((s) => shapeIds.has(s.shape_id)),
    calendar:      parsed.calendar.filter((c) => serviceIds.has(c.service_id)),
    calendarDates: parsed.calendarDates.filter((c) => serviceIds.has(c.service_id)),
    droppedTrips:  parsed.trips.length - trips.length,
  };
}

/**
 * Construye índice `stopsByRoute: { route_id: [stop_id, ...] }` a partir de
 * stop_times.txt + trips.txt. Permite al cliente saber qué paradas sirve cada
 * línea sin tener que traerse stop_times completo (~10-700MB descomprimido
 * según feed). El índice resultante para CABA pesa ~150-300KB gzip.
 *
 * Devuelve `null` si no hay stop_times.txt o si el feed config indica
 * `skipStopsByRoute: true` (escape para feeds demasiado grandes que pegan OOM).
 *
 * Memory: streaming line-by-line. CABA tiene ~13M filas (~700MB descomprimido)
 * y `parseCsv(text)` excedía el string limit de V8 (~512MB). Acá leemos linea
 * a linea con `readline` + parser CSV minimalista (no soportamos quotes —
 * stop_times.txt rara vez los usa). Memory pico ~50MB del Map + Set incremental.
 */
async function buildStopsByRoute(parsed, dir, feedConfig = {}) {
  if (feedConfig.skipStopsByRoute) return null;
  const stopTimesPath = path.join(dir, "stop_times.txt");
  if (!fs.existsSync(stopTimesPath)) return null;

  // Mapa trip_id → route_id (de trips ya filtrados).
  const tripToRoute = new Map();
  for (const t of parsed.trips) {
    tripToRoute.set(t.trip_id, t.route_id);
  }
  // Set de stop_ids retenidos tras el bbox filter — descartamos stop_times
  // que apuntan a stops fuera del bbox (no nos interesan en el output).
  const keptStopIds = new Set(parsed.stops.map((s) => s.stop_id));

  const fileStream = fs.createReadStream(stopTimesPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let header = null;
  let stopIdCol = -1;
  let tripIdCol = -1;
  const setByRoute = new Map(); // route_id → Set<stop_id>

  for await (const rawLine of rl) {
    const line = rawLine.charCodeAt(0) === 0xFEFF ? rawLine.slice(1) : rawLine; // strip BOM en línea 0
    if (header === null) {
      header = line.split(",").map((h) => h.trim());
      stopIdCol = header.indexOf("stop_id");
      tripIdCol = header.indexOf("trip_id");
      if (stopIdCol < 0 || tripIdCol < 0) {
        return null; // header no esperado, salir limpio
      }
      continue;
    }
    if (!line) continue;
    // Parser CSV minimalista: split por coma. GTFS stop_times.txt rara vez
    // usa quotes (no hay nombres con comas en estos campos). Si fuese
    // necesario soportarlos, refactor a `csv-parse/stream`.
    const fields = line.split(",");
    const tripId = fields[tripIdCol];
    const stopId = fields[stopIdCol];
    if (!tripId || !stopId) continue;
    const routeId = tripToRoute.get(tripId);
    if (!routeId) continue;
    if (!keptStopIds.has(stopId)) continue;
    let s = setByRoute.get(routeId);
    if (!s) { s = new Set(); setByRoute.set(routeId, s); }
    s.add(stopId);
  }

  const out = {};
  for (const [routeId, set] of setByRoute) {
    out[routeId] = Array.from(set);
  }
  return out;
}

/**
 * Snapshot final con counts y metadata.
 */
function buildSnapshot({ feedConfig, parsed, generatedAt = new Date().toISOString() }) {
  const out = {
    feedId:        feedConfig.feedId,
    sourceUrl:     feedConfig.sourceUrl,
    cityIds:       feedConfig.cityIds,
    bbox:          feedConfig.bbox,
    license:       feedConfig.license,
    generatedAt,
    counts: {
      stops:         parsed.stops.length,
      routes:        parsed.routes.length,
      trips:         parsed.trips.length,
      shapes:        parsed.shapes.length,
      calendar:      parsed.calendar.length,
      calendarDates: parsed.calendarDates.length,
      agency:        parsed.agency.length,
      droppedStops:  parsed.droppedStops || 0,
      droppedTrips:  parsed.droppedTrips || 0,
    },
    stops:         parsed.stops,
    routes:        parsed.routes,
    trips:         parsed.trips,
    shapes:        parsed.shapes,
    calendar:      parsed.calendar,
    calendarDates: parsed.calendarDates,
    agency:        parsed.agency,
    feedInfo:      parsed.feedInfo,
  };
  if (parsed.stopsByRoute) out.stopsByRoute = parsed.stopsByRoute;
  return out;
}

/**
 * Orquesta el pipeline completo. Para uso en Cloud Function.
 *
 * @param {object} feedConfig - entry de lib/static-feeds.js
 * @param {object} options - { strongCascade: bool }
 * @returns {Promise<{ snapshot, dir, durationMs }>}
 */
async function runPipeline(feedConfig, options = {}) {
  const t0 = Date.now();
  // `fetchUrl` lo inyecta el endpoint cuando el feed requiere auth (ver
  // `runStaticGtfsPipeline` en index.js). Default = `sourceUrl` para feeds
  // públicos. La URL pública (`sourceUrl`) sigue siendo la que se serializa
  // en el snapshot — no exponemos credenciales.
  const fetchUrl = feedConfig.fetchUrl || feedConfig.sourceUrl;
  const buf = await fetchZip(fetchUrl);
  const dir = extractToTmp(buf, feedConfig.feedId);
  try {
    const parsed = parseAll(dir);

    // Si el feed config trae KML auxiliar de recorridos, descargamos y
    // mergeamos los shapes (caso MTOP UY que NO incluye shapes.txt en GTFS).
    if (feedConfig.shapesKmlUrl && parsed.shapes.length === 0) {
      try {
        const kmlShapes = await fetchAndParseKml(
          feedConfig.shapesKmlUrl,
          feedConfig.kmlShapeIdField || "Variante"
        );
        parsed.shapes = kmlShapes;

        // Asignar shape_id a trips cuyo route_id matchee. Para MTOP, route_id
        // == Variante == shape_id (uno-a-uno). Otros feeds pueden necesitar
        // override del mapping — config.tripToShapeIdMapper.
        const knownShapeIds = new Set(kmlShapes.map((s) => s.shape_id));
        for (const trip of parsed.trips) {
          if (!trip.shape_id && knownShapeIds.has(trip.route_id)) {
            trip.shape_id = trip.route_id;
          }
        }
      } catch (e) {
        // Si el KML falla, seguimos sin shapes — el snapshot queda igual
        // que antes de este feature. No bloqueante.
        console.warn(`KML fetch failed for ${feedConfig.feedId}: ${e.message}`);
      }
    }

    const bboxFiltered = filterByBbox(parsed, feedConfig.bbox);
    const finalParsed = options.strongCascade
      ? strongCascadeFilter(parsed, bboxFiltered, dir)
      : bboxFiltered;
    finalParsed.stopsByRoute = await buildStopsByRoute(finalParsed, dir, feedConfig);
    const snapshot = buildSnapshot({ feedConfig, parsed: finalParsed });
    return { snapshot, dir, durationMs: Date.now() - t0 };
  } finally {
    rmdirSafe(dir);
  }
}

/**
 * Variante para testing: dado un dir local con archivos GTFS extraídos, corre
 * sólo parse + filtros (saltea fetch + extract).
 */
async function runPipelineFromLocalDir(feedConfig, dir, options = {}) {
  const parsed = parseAll(dir);
  const bboxFiltered = filterByBbox(parsed, feedConfig.bbox);
  const finalParsed = options.strongCascade
    ? strongCascadeFilter(parsed, bboxFiltered, dir)
    : bboxFiltered;
  finalParsed.stopsByRoute = await buildStopsByRoute(finalParsed, dir, feedConfig);
  return buildSnapshot({ feedConfig, parsed: finalParsed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming serialization
// ─────────────────────────────────────────────────────────────────────────────
//
// Serializa un snapshot JSON como stream de chunks (sin allocar el string
// completo). Cada array (stops/routes/trips/shapes/...) se escribe elemento
// por elemento, respetando backpressure del stream destino.
//
// Permite hacer `gzipStream.pipe(bucketWriteStream)` y bajar la memoria pico de
// la función — antes el `JSON.stringify(snapshot)` + `gzipSync` cargaban dos
// copias gigantes a memoria simultáneamente.
//
// Output: stream de bytes que es JSON válido idéntico al de
// `JSON.stringify(buildSnapshot(...))`.

const ARRAY_FIELDS = ["stops", "routes", "trips", "shapes", "calendar", "calendarDates", "agency", "feedInfo"];
const SCALAR_FIELDS = ["feedId", "sourceUrl", "cityIds", "bbox", "license", "generatedAt", "counts", "stopsByRoute"];

/**
 * Pone backpressure en un Writable: si el buffer interno está lleno, espera el
 * evento 'drain' antes de seguir escribiendo.
 */
function writeWithBackpressure(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => stream.once("drain", resolve));
}

/**
 * Escribe un array como JSON `[item1,item2,...]` elemento por elemento.
 * Stringify se hace por item — el JSON.stringify de un objeto ~200 bytes es
 * trivial en memoria.
 */
async function writeArrayStream(stream, arr) {
  await writeWithBackpressure(stream, "[");
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) await writeWithBackpressure(stream, ",");
    // Si una línea individual mete 50KB, write devuelve false y esperamos drain.
    // 'await' acá es necesario para no acumular pending writes que rompan memoria.
    await writeWithBackpressure(stream, JSON.stringify(arr[i]));
  }
  await writeWithBackpressure(stream, "]");
}

/**
 * Escribe el snapshot entero al `stream` como JSON canónico, en el orden:
 *   {feedId, sourceUrl, cityIds, bbox, license, generatedAt, counts,
 *    stops:[...], routes:[...], trips:[...], shapes:[...],
 *    calendar:[...], calendarDates:[...], agency:[...], feedInfo:[...]}
 *
 * No flushea el stream — lo deja abierto para que el caller decida `.end()`.
 */
async function writeSnapshotStream(snapshot, stream) {
  await writeWithBackpressure(stream, "{");

  // Scalar fields primero
  let first = true;
  for (const key of SCALAR_FIELDS) {
    if (!(key in snapshot)) continue;
    if (!first) await writeWithBackpressure(stream, ",");
    first = false;
    await writeWithBackpressure(stream, `${JSON.stringify(key)}:${JSON.stringify(snapshot[key])}`);
  }

  // Arrays después, streaming
  for (const key of ARRAY_FIELDS) {
    const arr = snapshot[key];
    if (!Array.isArray(arr)) continue;
    if (!first) await writeWithBackpressure(stream, ",");
    first = false;
    await writeWithBackpressure(stream, `${JSON.stringify(key)}:`);
    await writeArrayStream(stream, arr);
  }

  await writeWithBackpressure(stream, "}");
}

module.exports = {
  fetchZip,
  fetchAndParseKml,
  extractToTmp,
  parseAll,
  filterByBbox,
  strongCascadeFilter,
  buildStopsByRoute,
  buildSnapshot,
  runPipeline,
  runPipelineFromLocalDir,
  writeSnapshotStream,
  writeArrayStream,
};
