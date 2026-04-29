/**
 * Builder de snapshot estático para CODESA Maldonado.
 *
 * CODESA no publica GTFS. Sus líneas/recorridos/paradas están dispersos en
 * dos fuentes complementarias:
 *
 *   1. Google MyMaps (1 mid por línea+sentido) — provee la GEOMETRÍA:
 *      - 1-2 LineStrings: el recorrido del bus
 *      - N Points: terminales, agencias, hospitales (puntos de referencia,
 *        NO paradas individuales)
 *
 *   2. Página HTML de cada línea en codesa.com.uy/p/linea-X-(ida|vuelta).html
 *      provee la lista ORDENADA de paradas en texto:
 *      "Vialidad, Ruta 39, Juana Tabárez, Av. Rocha, ..."
 *      Cada página tiene bloque "Invierno" + "Verano" (variantes estacionales).
 *
 * Estrategia v2 (2026-04-27): combinar ambas fuentes:
 *   - LineStrings del MyMaps → shapes (sin cambio respecto a v1)
 *   - Texto de la subpágina → trips + stop_times + paradas individuales
 *     distribuidas uniformemente sobre el LineString del shape correspondiente
 *   - Paradas dedup por (nombre, sentido) — paradas en lados opuestos de la
 *     calle (ida vs vuelta) quedan separadas
 *
 * Limitaciones conocidas:
 *   - Coords de paradas son APROXIMADAS (distribuidas uniformemente sobre el
 *     LineString). Para corregir: pasar Geocoding API por cada nombre, snap
 *     al LineString. Pendiente v3.
 *   - Solo se procesa el bloque "Invierno" (9 meses al año). Variantes verano
 *     pendientes con calendar_dates GTFS.
 *   - Sin horarios de stop_times (arrival/departure null) — no hay datos.
 *
 * Para sumar líneas nuevas: agregar entry al objeto `MIDS` abajo. Para descubrir
 * mids nuevos cuando CODESA agregue líneas, correr:
 *   curl https://www.codesa.com.uy/p/recorridos.html | grep linea
 *   y por cada página `/p/linea-X-(ida|vuelta).html` extraer `mid=...`.
 */

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const KML_BASE = "https://www.google.com/maps/d/kml";
const HTML_BASE = "https://www.codesa.com.uy/p";

// Mapping discovery del 2026-04-27 — 22 líneas, 40 mids.
// Sentidos: "ida" / "vuelta" / "bi" (mid bidireccional para líneas pequeñas).
const MIDS = {
  "1":              { bi:    "1dO3YQTrzuLNnECHh0s27LloCkWJdbCja" },
  "3":              { ida:    "1LrQRn9KXcYCxq3L6VKEiGRTjeBkhys4",  vuelta: "1VhNbBfng8EpYhQKsxVpTDnPoB4Lcs0U" },
  "5":              { ida:    "1ddfKj31Oz8whoeppgXJFtm7-JsRhAN1V",  vuelta: "1LZnPFOsjd7lN6iFK52Mm55QPVBluKl7y" },
  "6-san-carlos":   { ida:    "1awQjyQbAVJVTDjWn1o0PCtOJCkGRHzA",   vuelta: "1iKtGis8xcvK9afqpYfC-j4h1uGnT8EE" },
  "7":              { ida:    "1xu-Ggu7YvoOshDuauAKkcIdufVMJO9MV",  vuelta: "1eGfSmA-WGzh_0sI-YaGcAd_XURe3e4M0" },
  "8":              { ida:    "1frL0y6qx_lDrENNDCqZzhXFj15I9uf82",  vuelta: "1R6jmUVItcR_H3y03sTjybnVgl9xFQze1" },
  "9":              { ida:    "1_8CGQAuyEIEeh1R_lHyfgeCxWxBfVwK2",  vuelta: "1pXBSAWIkvRRwUa4_X503YyGq7nGVCHU7" },
  "12":             { ida:    "1kkTVbbSKjL22Ycw8ksFJy9KoOaVgowBQ",  vuelta: "1vU2UIgJL2xNGzFWjQpUZKZb2wn3uZJ__" },
  "14":             { ida:    "1eHc74m_konHzQUMb9LULGoh-5FvXpRhm" },
  "14-bal-bs-as":   { ida:    "1TnjhdLYF2hEgcXRviLnRMOi4wbrAO5bN" },
  "24-de-agencia":  { ida:    "1AUSzUzRVgyEyeNPKU5Xb9B-NeY8XGGiR",  vuelta: "1Hh2G3HkLW2DA1JV1x8fFC6tdzCeazok3" },
  "24-vialidad":    { ida:    "1-efurj-16R8FE75goiMqwCDCEolWwRqb",  vuelta: "1YotBV80d0cCUfSz0sqYIU0xqBOQkBo4t" },
  "35":             { ida:    "1cPaK4XDKjpE9oeU2rfdGnUwAAkcJ98Q",   vuelta: "1mkxbIGGrufdlH8NNvJoIcRo6DfE6MLk" },
  "45":             { ida:    "12i9IGIHk4GJJJ5MmdgK4BS47dJ-I2XM",   vuelta: "1tUEULhY49tMpA6rPMxUJLRuhoM9qCGc" },
  "55":             { ida:    "1Z9AXFpMS7bNLSPHeKYsCjFMLRHAumJe0",  vuelta: "1YOyqC6t7yrPCN9dd-sWHF1enXbKr7Arp" },
  "61":             { ida:    "1mdKmcrGu_vQkctBg7p-woy861BgSvZcq",  vuelta: "1tka4rkdyvJ4mXEEgfEeoQm84Es7o21qK" },
  "247":            { ida:    "17INV4NgLeksX4lPwJKYW-wNB2PciTm4b",  vuelta: "1f_ORbs-tzNqpTJS3lelrdvst-aAty9T2" },
  "912":            { ida:    "1dSigR1MuYffWX6lUkAbXDrKSe1GophGz",  vuelta: "1hf2MG80RKpwVj5o5nTZeE-gyBHMeVUtA" },
  "d":              { ida:    "1zoULgKXeE4s13A29S8C0b0PHk957agk",   vuelta: "16qxMjGKW7_bFo93W1wq89kgHzPYf9Ow" },
  "l48":            { bi:    "19j98nyHWHdcjIOOA65CZLNaMF-ssWbHh" },
  "l49":            { ida:    "1yByhnrdTDGY5dFikUFlUH7g3rbIhI6ZW",  vuelta: "1UaIE2snoPSqns9zUc7utqf_fUiUvVuvD" },
  "l50":            { ida:    "1RgRUDM9MhGCXBVgzoGf0mkPy4O8Rinmh",  vuelta: "1hyr_HTqBxPrXtJ3oVDZu1UAFP4qTJJx_" },
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

/**
 * Patrones de Points que NO son paradas reales — son referencias geográficas
 * (terminales, agencias, indicaciones). El balance es delicado: queremos
 * paradas reales pero no contaminar con landmarks.
 */
const REFERENCE_PATTERNS = [
  /^Vialidad$/i,
  /^Agencia CODESA/i,
  /^Terminal /i,
  /^Punta del Este$/i,
  /^Maldonado$/i,
  /^Indicaciones/i,
  /^Variación/i,
];

function isReferencePoint(name) {
  if (!name) return false;
  return REFERENCE_PATTERNS.some((re) => re.test(name.trim()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scraping HTML de subpáginas codesa.com.uy/p/linea-*.html
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL de la subpágina HTML para una (línea, sentido).
 * Sentido "bi" → sin sufijo (ej `/p/linea-1.html`, `/p/linea-l48.html`)
 * Sentido "ida" / "vuelta" → con sufijo (ej `/p/linea-3-ida.html`)
 */
function htmlPagePathFor(routeId, sentido) {
  if (sentido === "bi") return `${HTML_BASE}/linea-${routeId}.html`;
  return `${HTML_BASE}/linea-${routeId}-${sentido}.html`;
}

/**
 * Limpia HTML simple a texto plano. Mantiene saltos de línea entre tags.
 */
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/**
 * Parsea la lista ORDENADA de paradas del texto descriptivo de una subpágina.
 *
 * El texto típico tiene estructura:
 *
 *   Línea 1 - IDA (invierno - desde marzo a diciembre de cada año)
 *   Vialidad, Ruta 39, Juana Tabárez, Av. Rocha, ...
 *
 *   Línea 1 - IDA (verano - desde diciembre a marzo)
 *   Vialidad, Ruta 39, ..., Rbla. Gral. Artigas (brava), El Mesana (24), ...
 *
 *   Pasadas de Interés
 *   Vialidad, Agencia CODESA, ...
 *
 * Estrategia: tomamos solo el bloque "invierno" (9 meses al año). Si no
 * existe explícito, tomamos el primer párrafo con varias comas que aparezca
 * después del título de la línea.
 *
 * Devuelve { stopNames: string[], variant: "invierno"|"unico" }.
 */
function parseStopNamesFromHtml(html) {
  const text = htmlToText(html);

  // Buscar bloque "(invierno - desde marzo a ... de cada año)"
  const winterMatch = text.match(/\((invierno|invierno y verano)[^)]*\)\s*\n([^\n]+)/i);
  if (winterMatch) {
    return { stopNames: splitStopNames(winterMatch[2]), variant: "invierno" };
  }

  // Fallback: párrafo con muchas comas después de "IDA" / "VUELTA" / "Recorrido"
  const ida = text.match(/(?:IDA|VUELTA|RECORRIDO)[^\n]*\n([^\n]+,[^\n]+,[^\n]+)/i);
  if (ida) {
    return { stopNames: splitStopNames(ida[1]), variant: "unico" };
  }

  // Last resort: primera línea larga con comas
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if ((line.match(/,/g) || []).length >= 4) {
      return { stopNames: splitStopNames(line), variant: "unico" };
    }
  }

  return { stopNames: [], variant: "none" };
}

/**
 * Split de un párrafo de paradas separadas por comas. Limpia paréntesis pero
 * preserva número de parada cuando aparece (ej "Baupres (18)" → "Baupres" con
 * stop_code "18").
 */
function splitStopNames(text) {
  return text
    .split(/,\s*/)
    .map((raw) => {
      // trim primero, después remover punto final (orden invertido fue bug)
      const trimmed = raw.trim().replace(/\.$/, "").trim();
      if (!trimmed) return null;
      // "Baupres (18)" → name "Baupres", code "18"
      // "Carlos Seijo (ruta vieja)" → name "Carlos Seijo (ruta vieja)" (no es número)
      const numMatch = trimmed.match(/^(.+?)\s*\((\d+)\)\s*$/);
      if (numMatch) return { name: numMatch[1].trim(), code: numMatch[2] };
      return { name: trimmed, code: null };
    })
    .filter(Boolean);
}

/**
 * Descarga la subpágina HTML y extrae paradas ordenadas.
 */
async function fetchAndParseLinePage(routeId, sentido) {
  const url = htmlPagePathFor(routeId, sentido);
  const r = await axios.get(url, { timeout: 15_000, responseType: "text" });
  return parseStopNamesFromHtml(r.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Distribución uniforme de paradas sobre un LineString
// ─────────────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371000;

/**
 * `a` y `b` son `[lat, lng]` arrays (formato del LineString del KML).
 */
function haversineMeters(a, b) {
  const lat1 = a[0], lng1 = a[1];
  const lat2 = b[0], lng2 = b[1];
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(x));
}

/**
 * Calcula array de distancias acumuladas a lo largo del LineString.
 * Devuelve array de N elementos donde [i] = distancia desde points[0] hasta points[i].
 */
function cumulativeDistances(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return out;
}

/**
 * Devuelve `[lat, lng]` interpolado a una distancia dada a lo largo del LineString.
 */
function pointAtDistance(points, cumDistances, targetDist) {
  if (targetDist <= 0) return points[0];
  const total = cumDistances[cumDistances.length - 1];
  if (targetDist >= total) return points[points.length - 1];

  // Búsqueda binaria del segmento que contiene targetDist
  let lo = 0, hi = cumDistances.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDistances[mid] <= targetDist) lo = mid;
    else hi = mid;
  }

  const segLen = cumDistances[hi] - cumDistances[lo];
  const t = segLen > 0 ? (targetDist - cumDistances[lo]) / segLen : 0;
  return [
    points[lo][0] + t * (points[hi][0] - points[lo][0]),
    points[lo][1] + t * (points[hi][1] - points[lo][1]),
  ];
}

/**
 * Distribuye N paradas uniformemente sobre un LineString. Primer parada en el
 * extremo origen, última parada en el extremo destino. Las intermedias se
 * espacian proporcional a la longitud total del path.
 *
 * Devuelve array de { name, code, lat, lng, sequence } en el mismo orden que
 * stopList.
 */
function distributeStopsOnLineString(stopList, lineStringPoints) {
  if (stopList.length === 0 || lineStringPoints.length < 2) return [];
  const cum = cumulativeDistances(lineStringPoints);
  const total = cum[cum.length - 1];
  const N = stopList.length;
  const out = [];
  for (let i = 0; i < N; i++) {
    const targetDist = N === 1 ? 0 : (i / (N - 1)) * total;
    const coord = pointAtDistance(lineStringPoints, cum, targetDist);
    out.push({
      name:     stopList[i].name,
      code:     stopList[i].code,
      lat:      coord[0],
      lng:      coord[1],
      sequence: i + 1,
    });
  }
  return out;
}

/**
 * Descarga un KML desde MyMaps y devuelve {lineStrings, points} crudos.
 */
async function fetchAndParseKml(mid) {
  const url = `${KML_BASE}?mid=${mid}&forcekml=1`;
  const r = await axios.get(url, { timeout: 15_000, responseType: "text" });
  const xml = xmlParser.parse(r.data);

  // El name del Document es "Línea X (sentido) CODESA"
  const docName = xml?.kml?.Document?.name || "";

  const lineStrings = [];
  const points = [];

  walkPlacemarks(xml, (pm) => {
    const name = (pm?.name || "").toString().trim();

    // LineString — un recorrido
    const lsCoords = pm?.LineString?.coordinates;
    if (typeof lsCoords === "string") {
      const pts = parseCoordsList(lsCoords);
      if (pts.length >= 2) lineStrings.push({ name, points: pts });
      return;
    }

    // Point — potencial parada
    const ptCoords = pm?.Point?.coordinates;
    if (typeof ptCoords === "string") {
      const parts = ptCoords.trim().split(",");
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        points.push({ name, lat, lng });
      }
    }
  });

  return { docName, lineStrings, points };
}

function walkPlacemarks(node, cb) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkPlacemarks(n, cb);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === "Placemark") {
      if (Array.isArray(val)) val.forEach(cb);
      else cb(val);
    } else if (typeof val === "object") {
      walkPlacemarks(val, cb);
    }
  }
}

function parseCoordsList(str) {
  const tokens = str.trim().split(/\s+/);
  const points = [];
  for (const t of tokens) {
    const parts = t.split(",");
    if (parts.length < 2) continue;
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push([lat, lng]);
  }
  return points;
}

/**
 * Builder principal: descarga todos los KMLs en paralelo, agrega routes/shapes/
 * stops, devuelve StaticCatalog listo para gzip + upload a Cloud Storage.
 */
async function buildSnapshot({ feedConfig }) {
  // Plano de tareas: por cada (línea, sentido) un fetch de KML + un fetch de HTML
  const tasks = [];
  for (const [routeId, sentidos] of Object.entries(MIDS)) {
    for (const [sentido, mid] of Object.entries(sentidos)) {
      tasks.push({ routeId, sentido, mid });
    }
  }

  // Fetch en paralelo: cada task descarga KML + HTML simultaneamente
  const results = await mapWithConcurrency(tasks, 8, async (task) => {
    try {
      const [kml, html] = await Promise.all([
        fetchAndParseKml(task.mid),
        fetchAndParseLinePage(task.routeId, task.sentido).catch((e) => {
          // Si la subpágina HTML falla (404, parser fail), seguimos con
          // los Points del KML como fallback
          return { stopNames: [], variant: "fallback", htmlError: e.message };
        }),
      ]);
      return { ...task, ...kml, html, ok: true };
    } catch (e) {
      return { ...task, ok: false, error: e.message };
    }
  });

  // Acumular structures
  const allRoutes = new Map();
  const allShapes = [];
  const allTrips  = [];
  const allStopTimes = [];
  const stopsByKey = new Map(); // dedup por (nombre, sentido)

  let nextStopIdNum = 1;
  let nextTripIdNum = 1;

  function getOrCreateStop(name, code, lat, lng, sentido) {
    const key = `${name.toLowerCase()}|${sentido}`;
    if (stopsByKey.has(key)) return stopsByKey.get(key);
    const stop = {
      stop_id:         `codesa_${nextStopIdNum++}`,
      stop_code:       code,
      stop_name:       name,
      stop_lat:        lat,
      stop_lon:        lng,
      location_type:   0,
      parent_station:  null,
      wheelchair_boarding: null,
      // Metadata propia (no GTFS estándar) — útil para UI
      sentido,
    };
    stopsByKey.set(key, stop);
    return stop;
  }

  for (const r of results) {
    if (!r.ok) continue;

    // Route entry (1 por routeId, no por sentido)
    if (!allRoutes.has(r.routeId)) {
      allRoutes.set(r.routeId, {
        route_id:         r.routeId,
        agency_id:        "CODESA",
        route_short_name: r.routeId.toUpperCase(),
        route_long_name:  null,
        route_type:       3,
        route_color:      null,
        route_text_color: null,
      });
    }

    const route = allRoutes.get(r.routeId);
    if (!route.route_long_name && r.docName) {
      route.route_long_name = r.docName.replace(/\s+CODESA\s*$/, "").trim();
    }

    // direction_id GTFS: 0=ida/bi, 1=vuelta
    const directionId = r.sentido === "vuelta" ? 1 : 0;

    // Shape principal: usar el LineString más largo del MyMaps. Si hay varios
    // (variantes), el primero (índice 0) suele ser el principal.
    const primaryLs = r.lineStrings[0];
    const primaryShapeId = primaryLs ? `${r.routeId}_${r.sentido}` : null;

    // Shapes: cada LineString → un shape distinto (mantenemos todas las variantes)
    for (let i = 0; i < r.lineStrings.length; i++) {
      const ls = r.lineStrings[i];
      const suffix = r.lineStrings.length > 1 ? `_${i}` : "";
      const shapeId = `${r.routeId}_${r.sentido}${suffix}`;
      allShapes.push({
        shape_id: shapeId,
        points:   ls.points,
        variant_name: ls.name || null,
        route_id: r.routeId,
        sentido:  r.sentido,
      });
    }

    // Filtrar paradas reales del listado HTML (las "Pasadas de Interés" que
    // matchean REFERENCE_PATTERNS son terminales/landmarks, no paradas)
    const realStops = (r.html?.stopNames || []).filter((s) => !isReferencePoint(s.name));

    // Si hay LineString + lista de paradas → distribuir uniformemente y crear
    // trip + stop_times. Si no, fallback a Points del KML como hacía antes.
    if (primaryLs && realStops.length > 0) {
      const distributed = distributeStopsOnLineString(realStops, primaryLs.points);
      const tripId = `codesa_t${nextTripIdNum++}`;
      allTrips.push({
        route_id:      r.routeId,
        service_id:    "CODESA_DEFAULT",
        trip_id:       tripId,
        trip_headsign: r.docName ? r.docName.replace(/\s+CODESA\s*$/, "").trim() : null,
        direction_id:  directionId,
        shape_id:      primaryShapeId,
        block_id:      null,
        wheelchair_accessible: null,
        bikes_allowed: null,
      });

      for (const ds of distributed) {
        const stop = getOrCreateStop(ds.name, ds.code, ds.lat, ds.lng, r.sentido);
        allStopTimes.push({
          trip_id:        tripId,
          arrival_time:   null,
          departure_time: null,
          stop_id:        stop.stop_id,
          stop_sequence:  ds.sequence,
          stop_headsign:  null,
          pickup_type:    0,
          drop_off_type:  0,
          shape_dist_traveled: null,
        });
      }
    } else {
      // Fallback v1: usar Points del KML como paradas (sin trip ni stop_times)
      for (const p of r.points) {
        if (isReferencePoint(p.name)) continue;
        getOrCreateStop(p.name, null, p.lat, p.lng, r.sentido);
      }
    }
  }

  const failedTasks = results.filter((r) => !r.ok);
  const htmlFailedCount = results.filter((r) => r.ok && r.html?.htmlError).length;

  // Calendar mínimo: un service_id "CODESA_DEFAULT" lun-dom todo el año.
  // Variantes invierno/verano + frecuencias por día son v3.
  const today = new Date();
  const startDate = `${today.getFullYear()}0101`;
  const endDate   = `${today.getFullYear() + 1}1231`;

  return {
    feedId:     feedConfig.feedId,
    sourceUrl:  "https://www.codesa.com.uy/p/linea-*.html + Google MyMaps (40 mids)",
    cityIds:    feedConfig.cityIds,
    bbox:       feedConfig.bbox,
    license:    feedConfig.license,
    generatedAt: new Date().toISOString(),
    counts: {
      stops:         stopsByKey.size,
      routes:        allRoutes.size,
      trips:         allTrips.length,
      stopTimes:     allStopTimes.length,
      shapes:        allShapes.length,
      calendar:      1,
      calendarDates: 0,
      agency:        1,
      droppedStops:  0,
      droppedTrips:  0,
      kmlFailed:     failedTasks.length,
      htmlFailed:    htmlFailedCount,
    },
    stops:     Array.from(stopsByKey.values()),
    routes:    Array.from(allRoutes.values()),
    trips:     allTrips,
    stopTimes: allStopTimes,
    shapes:    allShapes,
    calendar: [{
      service_id: "CODESA_DEFAULT",
      monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
      start_date: startDate,
      end_date:   endDate,
    }],
    calendarDates: [],
    agency: [{
      agency_id:       "CODESA",
      agency_name:     "CODESA Cooperativa de Empresarios del Este S.A.",
      agency_url:      "https://www.codesa.com.uy",
      agency_timezone: "America/Montevideo",
      agency_lang:     "es",
    }],
    feedInfo: [{
      feed_publisher_name: "Vamo / CODESA MyMaps + HTML scraper",
      feed_publisher_url:  "https://www.codesa.com.uy",
      feed_lang:           "es",
      feed_version:        new Date().toISOString().slice(0, 10),
    }],
  };
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

module.exports = {
  buildSnapshot,
  MIDS,
  fetchAndParseKml,
  isReferencePoint,
  // Exportados para testing del scraper HTML
  htmlPagePathFor,
  parseStopNamesFromHtml,
  fetchAndParseLinePage,
  distributeStopsOnLineString,
};
