/**
 * Adapter GTFS-Realtime en formato JSON (no protobuf).
 *
 * Algunos operadores publican GTFS-RT decodificado a JSON en vez del wire
 * protobuf estándar. La estructura es 1:1 con la spec, sólo cambia el wire
 * format. Ejemplos: Renfe (España), algunos feeds de Mobility Database.
 *
 * Estructura esperada:
 *   {
 *     "header": { "gtfsRealtimeVersion": "2.0", "timestamp": "..." },
 *     "entity": [
 *       {
 *         "id": "VP_04345",
 *         "vehicle": {
 *           "trip": { "tripId": "...", "routeId": "...", ... },
 *           "position": { "latitude": ..., "longitude": ..., "bearing": ... },
 *           "currentStatus": "IN_TRANSIT_TO",
 *           "stopId": "...",
 *           "vehicle": { "id": "...", "label": "..." }
 *         }
 *       },
 *       ...
 *     ]
 *   }
 *
 * El registry pasa al adapter `bbox` opcional para filtrar el feed nacional
 * (ej Renfe larga distancia cubre España entera; cuando el user activa
 * "Madrid · Tren", solo querés los trenes en bbox Madrid).
 */

const { z } = require("zod");

// Box sanitizador del entity individual. Lat/lng requeridos, todo lo demás
// optional para tolerar feeds parciales.
const RtJsonEntitySchema = z.object({
  id: z.string().optional(),
  vehicle: z.object({
    trip: z.object({
      tripId:    z.string().optional(),
      routeId:   z.string().optional(),
      startTime: z.string().optional(),
      startDate: z.string().optional(),
      directionId: z.coerce.number().int().optional(),
    }).passthrough().optional(),
    position: z.object({
      latitude:  z.coerce.number(),
      longitude: z.coerce.number(),
      bearing:   z.coerce.number().optional(),
      speed:     z.coerce.number().optional(), // m/s en spec
      odometer:  z.coerce.number().optional(),
    }).passthrough(),
    currentStatus: z.string().optional(),
    stopId:        z.string().optional(),
    currentStopSequence: z.coerce.number().int().optional(),
    vehicle: z.object({
      id:    z.string().optional(),
      label: z.string().optional(),
      licensePlate: z.string().optional(),
    }).passthrough().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  }).passthrough(),
}).passthrough();

/**
 * Heurística para mostrar un identificador legible de la ruta cuando el feed
 * no la trae explícita. Para tripIds tipo Renfe `<5-digit-route><seq><date>`,
 * extrae el prefijo numérico inicial. Para routeIds/tripIds cortos (<10 char)
 * los devuelve enteros.
 */
function deriveRouteShortName(trip) {
  if (trip.routeShortName && typeof trip.routeShortName === "string") {
    return trip.routeShortName.trim() || null;
  }
  if (trip.routeId && typeof trip.routeId === "string") {
    return trip.routeId.trim() || null;
  }
  if (trip.tripId && typeof trip.tripId === "string") {
    const tid = trip.tripId.trim();
    // Renfe pattern: "0434522026-04-26" → prefijo numérico antes de un guión
    // o de un grupo "20XX-MM-DD". Extraemos el primer chunk de dígitos.
    const m = tid.match(/^(\d{3,6})/);
    if (m) return m[1];
    return tid.length > 12 ? tid.slice(0, 8) : tid;
  }
  return null;
}

const STATUS_MAP = {
  "INCOMING_AT":   "incoming_at",
  "STOPPED_AT":    "stopped_at",
  "IN_TRANSIT_TO": "in_transit_to",
  "0": "incoming_at",
  "1": "stopped_at",
  "2": "in_transit_to",
  "3": "unknown",
};

/**
 * Mapea un entity al schema canónico `TransitVehicle`.
 * @param {object} entity - entity validado
 * @param {object} ctx - { cityId, mode, feedSource, agencyName }
 */
function mapEntity(entity, ctx) {
  const v = entity.vehicle;
  if (!v?.position) return null;
  const lat = v.position.latitude;
  const lng = v.position.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  // Speed: GTFS-RT spec dice m/s. Convertir a km/h. Algunos feeds no la traen.
  const speedKmh = (typeof v.position.speed === "number" && v.position.speed >= 0)
    ? Math.round(v.position.speed * 3.6 * 10) / 10
    : null;

  const vehicleId = v.vehicle?.id || v.vehicle?.label || entity.id || "?";

  return {
    id:         `${ctx.feedSource}:${vehicleId}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat,
      lng,
      bearing:   (typeof v.position.bearing === "number") ? v.position.bearing : null,
      speed:     speedKmh,
      odometerM: (typeof v.position.odometer === "number") ? v.position.odometer : null,
      altitudeM: null,
    },
    trip: v.trip ? {
      routeId:        v.trip.routeId || null,
      // Si no hay routeShortName explícito, derivamos del tripId. Renfe
      // emite tripIds tipo "0434522026-04-26" (5 dígitos route + 1 dígito
      // secuencia + fecha). El prefijo 5-char es la línea/relación.
      routeShortName: deriveRouteShortName(v.trip),
      tripId:         v.trip.tripId || null,
      startTime:      v.trip.startTime || null,
      startDate:      v.trip.startDate || null,
      headsign:       null,
      direction:      (typeof v.trip.directionId === "number") ? v.trip.directionId : null,
    } : null,
    agency: ctx.agencyName ? {
      id:   ctx.agencyId || null,
      name: ctx.agencyName,
    } : null,
    currentStopSequence: (typeof v.currentStopSequence === "number") ? v.currentStopSequence : null,
    currentStopId:       v.stopId || null,
    currentStatus:       v.currentStatus ? (STATUS_MAP[String(v.currentStatus)] || null) : null,
    congestionLevel:     null,
    enrichment:          null,
    timestamp:           v.timestamp ? Number(v.timestamp) : null,
  };
}

/**
 * Mapea el feed JSON entero. Si `ctx.bbox` viene, filtra vehículos fuera
 * del bbox antes de mapear (útil para feeds nacionales que se exponen como
 * varias ciudades).
 */
function mapFeedToVehicles(json, ctx) {
  const entities = Array.isArray(json?.entity) ? json.entity : [];
  const valid = [];
  const rejected = [];

  for (const raw of entities) {
    const parsed = RtJsonEntitySchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ raw, reason: parsed.error.issues?.[0]?.message || "schema fail" });
      continue;
    }

    // Filtro bbox antes de mapear (más rápido)
    if (ctx.bbox) {
      const lat = parsed.data.vehicle.position.latitude;
      const lng = parsed.data.vehicle.position.longitude;
      if (lat < ctx.bbox.swLat || lat > ctx.bbox.neLat ||
          lng < ctx.bbox.swLng || lng > ctx.bbox.neLng) {
        continue; // fuera de bbox — silent skip
      }
    }

    const mapped = mapEntity(parsed.data, ctx);
    if (mapped) valid.push(mapped);
  }

  // feedTimestamp del header (segundos POSIX, viene como string)
  let feedTimestamp = null;
  if (json?.header?.timestamp) {
    const ts = Number(json.header.timestamp);
    // Algunos feeds (Renfe) emiten timestamp en milisegundos (13 digits) en
    // vez de segundos. Detectamos por tamaño y normalizamos.
    if (Number.isFinite(ts)) {
      feedTimestamp = ts > 9_999_999_999 ? Math.floor(ts / 1000) : Math.floor(ts);
    }
  }

  return {
    vehicles:        valid,
    feedTimestamp,
    rejectedCount:   rejected.length,
    sampleRejections: rejected.slice(0, 3),
  };
}

module.exports = {
  RtJsonEntitySchema,
  mapEntity,
  mapFeedToVehicles,
};
