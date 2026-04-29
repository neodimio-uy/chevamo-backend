/**
 * Adapter para Carris Metropolitana Lisboa — feed
 * `https://api.carrismetropolitana.pt/v2/vehicles` (JSON propio enriquecido).
 *
 * Box sanitizador Zod: validamos lo que llega del backend de CM antes de
 * mapearlo al schema canónico Vamo.
 *
 * Características del feed Lisboa (validado 2026-04-26):
 *   - API pública sin auth
 *   - JSON enriquecido con datos físicos del vehículo (license_plate, make,
 *     model, capacity_total/seated/standing, propulsion, wheelchair_accessible,
 *     bikes_allowed, registration_date)
 *   - 4 agencias operadoras (41/42/43/44)
 *   - 1.677 vehículos totales con ~96% reportando GPS válido
 *   - 714 líneas, 12.702 paradas
 *   - Mix propulsión: ~82% diesel, ~14% eléctrico, resto híbrido/GNC/GLP
 *
 * Se mapea más rico que GTFS-RT estándar — el adapter llena `enrichment`
 * que la mayoría de feeds dejan vacío.
 */

const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod
// ─────────────────────────────────────────────────────────────────────────────

const CmLisboaVehicleRawSchema = z.object({
  id:                    z.string(),
  agency_id:             z.string().nullable().optional(),
  trip_id:               z.string().nullable().optional(),
  pattern_id:            z.string().nullable().optional(),
  route_id:              z.string().nullable().optional(),
  shift_id:              z.string().nullable().optional(),
  block_id:              z.string().nullable().optional(),
  bearing:               z.number().nullable().optional(),
  current_status:        z.string().nullable().optional(),
  lat:                   z.number().nullable().optional(),
  lon:                   z.number().nullable().optional(),
  speed:                 z.number().nullable().optional(), // m/s
  timestamp:             z.number().int().nullable().optional(),
  status_timestamp:      z.number().int().nullable().optional(),
  // enriquecimientos del vehículo físico
  license_plate:         z.string().nullable().optional(),
  make:                  z.string().nullable().optional(),
  model:                 z.string().nullable().optional(),
  owner:                 z.string().nullable().optional(),
  propulsion:            z.string().nullable().optional(),
  capacity_total:        z.number().int().nullable().optional(),
  capacity_seated:       z.number().int().nullable().optional(),
  capacity_standing:     z.number().int().nullable().optional(),
  wheelchair_accessible: z.boolean().nullable().optional(),
  bikes_allowed:         z.boolean().nullable().optional(),
  contactless:           z.boolean().nullable().optional(),
  registration_date:     z.string().nullable().optional(),
  schedule_relationship: z.union([z.string(), z.number()]).nullable().optional(),
  current_stop_sequence: z.number().int().nullable().optional(),
  stop_id:               z.string().nullable().optional(),
}).passthrough();

const CmLisboaVehicleListRawSchema = z.array(CmLisboaVehicleRawSchema);

// Mapping current_status (Lisboa usa string) → canónico
const STATUS_MAP = {
  "INCOMING_AT":    "incoming_at",
  "STOPPED_AT":     "stopped_at",
  "IN_TRANSIT_TO":  "in_transit_to",
  "0":              "incoming_at",
  "1":              "stopped_at",
  "2":              "in_transit_to",
  "3":              "unknown",
};

// Mapping propulsion (CM normaliza a strings comunes)
const PROPULSION_MAP = {
  "electricity":  "electricity",
  "diesel":       "diesel",
  "hybrid":       "hybrid",
  "natural_gas":  "natural_gas",
  "lpg_auto":     "lpg_auto",
  "lpg":          "lpg_auto",
  "hydrogen":     "hydrogen",
};

// ─────────────────────────────────────────────────────────────────────────────
// Mapper a schema canónico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapea un vehicle del feed CM Lisboa al schema canónico Vamo.
 */
function mapCmLisboaVehicle(raw, ctx) {
  // Speed m/s → km/h
  const speedKmh = (typeof raw.speed === "number" && raw.speed >= 0)
    ? Math.round(raw.speed * 3.6 * 10) / 10
    : null;

  // Filtro: si no tiene lat/lng, descartamos (el feed devuelve algunos sin pos)
  if (typeof raw.lat !== "number" || typeof raw.lon !== "number") {
    return null;
  }

  return {
    id:         `${ctx.feedSource}:${raw.id}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat:       raw.lat,
      lng:       raw.lon,
      bearing:   (typeof raw.bearing === "number") ? raw.bearing : null,
      speed:     speedKmh,
      odometerM: null,
      altitudeM: null,
    },
    trip: raw.trip_id || raw.route_id ? {
      routeId:        raw.route_id || "",
      routeShortName: null, // CM no inyecta short_name en vehicles, lookup en /v1/lines
      tripId:         raw.trip_id || null,
      startTime:      null,
      startDate:      null,
      headsign:       null, // lookup en patterns
      direction:      null,
    } : null,
    agency: raw.agency_id ? {
      id:   raw.agency_id,
      name: null, // lookup en /v1/agencies
    } : null,
    currentStopSequence: (typeof raw.current_stop_sequence === "number") ? raw.current_stop_sequence : null,
    currentStopId:       raw.stop_id || null,
    currentStatus:       raw.current_status ? (STATUS_MAP[String(raw.current_status)] || null) : null,
    congestionLevel:     null, // CM no lo expone
    enrichment: {
      licensePlate:        raw.license_plate || null,
      make:                raw.make || null,
      model:               raw.model || null,
      propulsion:          raw.propulsion ? (PROPULSION_MAP[raw.propulsion] || "unknown") : null,
      capacityTotal:       raw.capacity_total ?? null,
      capacitySeated:      raw.capacity_seated ?? null,
      wheelchairAccessible: raw.wheelchair_accessible ?? null,
      bikesAllowed:        raw.bikes_allowed ?? null,
      registrationDate:    raw.registration_date || null,
    },
    timestamp: raw.timestamp ?? null,
  };
}

/**
 * Mapea la respuesta completa del feed CM Lisboa.
 */
function mapFeedToVehicles(rawArray, ctx) {
  const valid = [];
  const rejected = [];
  for (const raw of rawArray) {
    const parsed = CmLisboaVehicleRawSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ raw, reason: parsed.error.issues?.[0]?.message || "schema fail" });
      continue;
    }
    const mapped = mapCmLisboaVehicle(parsed.data, ctx);
    if (mapped) valid.push(mapped);
  }

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
  CmLisboaVehicleRawSchema,
  CmLisboaVehicleListRawSchema,
  mapCmLisboaVehicle,
  mapFeedToVehicles,
};
