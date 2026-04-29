/**
 * Adapter para CODESA Maldonado/Punta del Este — feed `avl.xml`.
 *
 * URL pública sin auth, CORS abierto:
 *   http://ip.codesa.com.uy/pub/avl.xml
 *
 * CODESA usa la plataforma "Busmatick Server" para tracking. El XML público
 * es consumido por su propia web (`/p/seguimiento-satelital.html` → iframe a
 * `ip.codesa.com.uy/pub/`). Refresh sugerido: 15s.
 *
 * Shape del XML:
 *   <list>
 *     <marker>
 *       <lin>numero de línea</lin>
 *       <tra>trayecto / sentido</tra>
 *       <lat>-34.92...</lat>
 *       <lon>-54.95...</lon>
 *       <bac>1 si accesible (low floor)</bac>
 *       <bus>id del bus</bus>
 *       <fec>YYYY-MM-DD</fec>
 *       <hor>HH:MM:SS</hor>
 *       <con>...nombre del conductor</con>
 *     </marker>
 *     ...
 *   </list>
 *
 * Box sanitizador Zod aplicado al output del parser XML antes de mapear al
 * schema canónico. Los campos numéricos vienen como string en XML.
 */

const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod
// ─────────────────────────────────────────────────────────────────────────────

// Bbox Maldonado/Punta del Este + margen suburbano (San Carlos, Pan de Azúcar).
// Rechaza coords fuera para descartar parses corruptos.
const MALDO_LAT_MIN = -35.20;
const MALDO_LAT_MAX = -34.40;
const MALDO_LNG_MIN = -55.50;
const MALDO_LNG_MAX = -54.20;

const CodesaMarkerRawSchema = z.object({
  lin: z.coerce.string().trim().min(1).max(15),
  tra: z.coerce.string().trim().max(50).optional().nullable(),
  lat: z.coerce.number().min(MALDO_LAT_MIN).max(MALDO_LAT_MAX),
  lon: z.coerce.number().min(MALDO_LNG_MIN).max(MALDO_LNG_MAX),
  bac: z.coerce.number().int().optional().nullable(),
  bus: z.coerce.string().trim().min(1).max(20),
  fec: z.coerce.string().trim().optional().nullable(),
  hor: z.coerce.string().trim().optional().nullable(),
  con: z.coerce.string().trim().max(100).optional().nullable(),
}).passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// Mapper a schema canónico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapea un marker del feed CODESA al schema canónico Vamo.
 * @param {object} raw - marker validado por CodesaMarkerRawSchema
 * @param {object} ctx - { cityId, mode, feedSource }
 */
function mapCodesaMarker(raw, ctx) {
  // CODESA combina fec+hor para timestamp de cada marker. Convertimos a POSIX
  // seconds en zona UY (America/Montevideo). El XML viene en hora local,
  // sin offset — asumimos UY UTC-3.
  let timestamp = null;
  if (raw.fec && raw.hor) {
    // ISO en UTC: armado manual restando -3h
    const [y, m, d] = raw.fec.split("-").map(Number);
    const [hh, mm, ss] = (raw.hor.split(":").concat(["0"]))
      .slice(0, 3)
      .map(Number);
    if (Number.isFinite(y) && Number.isFinite(hh)) {
      // UY = UTC-3. Date.UTC para construir hora UTC equivalente.
      const utcMs = Date.UTC(y, m - 1, d, hh + 3, mm || 0, ss || 0);
      timestamp = Math.floor(utcMs / 1000);
    }
  }

  return {
    id:         `${ctx.feedSource}:${raw.bus}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat:       raw.lat,
      lng:       raw.lon,
      bearing:   null,
      speed:     null,
      odometerM: null,
      altitudeM: null,
    },
    trip: {
      routeId:        raw.lin,
      routeShortName: raw.lin,
      tripId:         null,
      startTime:      raw.hor || null,
      startDate:      raw.fec ? raw.fec.replaceAll("-", "") : null,
      headsign:       raw.tra || null,
      direction:      null,
    },
    agency: {
      id:   "CODESA",
      name: "CODESA",
    },
    currentStopSequence: null,
    currentStopId:       null,
    currentStatus:       null,
    congestionLevel:     null,
    enrichment: {
      licensePlate:        null,
      make:                null,
      model:               null,
      propulsion:          null,
      capacityTotal:       null,
      capacitySeated:      null,
      wheelchairAccessible: raw.bac === 1 ? true : null,
      bikesAllowed:        null,
      registrationDate:    null,
    },
    timestamp,
  };
}

/**
 * Recibe el XML de avl.xml ya parseado a JS por fast-xml-parser, lo pasa
 * por sanitizer + mapper. El parser retorna `{ list: { marker: [...] } }`
 * o `{ list: { marker: {} } }` (single marker), lo normalizamos a array.
 */
function mapFeedToVehicles(parsed, ctx) {
  // fast-xml-parser default: si list tiene un solo marker, lo entrega como
  // objeto suelto en vez de array de 1. Normalizamos.
  let markers = parsed?.list?.marker;
  if (!markers) markers = [];
  if (!Array.isArray(markers)) markers = [markers];

  const valid = [];
  const rejected = [];
  for (const raw of markers) {
    const sanitized = CodesaMarkerRawSchema.safeParse(raw);
    if (!sanitized.success) {
      rejected.push({ raw, reason: sanitized.error.issues?.[0]?.message || "schema fail" });
      continue;
    }
    valid.push(mapCodesaMarker(sanitized.data, ctx));
  }

  // feedTimestamp: max de los markers válidos (o null si todos sin timestamp)
  const timestamps = valid.map((v) => v.timestamp).filter((t) => t != null);
  const feedTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return {
    vehicles:        valid,
    feedTimestamp,
    rejectedCount:   rejected.length,
    sampleRejections: rejected.slice(0, 3),
  };
}

module.exports = {
  CodesaMarkerRawSchema,
  mapCodesaMarker,
  mapFeedToVehicles,
};
