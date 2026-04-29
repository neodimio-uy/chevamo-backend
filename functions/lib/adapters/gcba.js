/**
 * Adapter para GCBA (Gobierno de la Ciudad de Buenos Aires) — feed
 * `/colectivos/vehiclePositionsSimple` que es JSON enriquecido custom
 * (NO GTFS-RT estándar protobuf — más rico que GTFS-RT, pero formato propio).
 *
 * Box sanitizador Zod: validamos lo que llega del backend GCBA antes de
 * mapearlo al schema canónico Vamo.
 *
 * Ventajas del Simple sobre el protobuf estándar (`/colectivos/vehiclePositions`):
 *   - JSON plano (no requiere parser protobuf)
 *   - Trae `route_short_name`, `agency_name`, `trip_headsign` ya inyectados
 *   - Filtra unidades sin trip activo (más limpio que protobuf que incluye garage)
 *
 * Bug conocido del API: campo se llama `tip_id` (typo de `trip_id`) — mapeamos.
 */

const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod del input GCBA
// ─────────────────────────────────────────────────────────────────────────────

const GcbaVehicleRawSchema = z.object({
  route_id:         z.union([z.string(), z.number()]).transform((v) => String(v)),
  route_short_name: z.string().trim().max(50).nullable().optional(),
  agency_id:        z.union([z.string(), z.number()]).transform((v) => String(v)).nullable().optional(),
  agency_name:      z.string().trim().max(100).nullable().optional(),
  latitude:         z.number(),
  longitude:        z.number(),
  speed:            z.number().min(0).max(70).nullable().optional(), // m/s — GCBA usa m/s
  timestamp:        z.number().int(),
  id:               z.union([z.string(), z.number()]).transform((v) => String(v)),
  direction:        z.number().int().min(0).max(1).nullable().optional(),
  // Bug GCBA: campo es `tip_id`. Mantenemos ambos para compatibilidad
  trip_id:          z.string().trim().nullable().optional(),
  tip_id:           z.string().trim().nullable().optional(),
  trip_headsign:    z.string().trim().max(200).nullable().optional(),
}).passthrough(); // tolera campos extras que GCBA pueda agregar

const GcbaVehicleListRawSchema = z.array(GcbaVehicleRawSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Mapper a schema canónico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapea un vehicle del feed GCBA Simple al schema canónico Vamo.
 *
 * @param {object} raw - vehicle del feed (validado contra GcbaVehicleRawSchema)
 * @param {object} ctx - { cityId, mode, feedSource }
 */
function mapGcbaVehicle(raw, ctx) {
  // Speed: GCBA reporta m/s, normalizamos a km/h (igual que gtfs-rt-generic)
  const speedKmh = (typeof raw.speed === "number" && raw.speed >= 0)
    ? Math.round(raw.speed * 3.6 * 10) / 10
    : null;

  // Bug typo: `tip_id` → `trip_id`. Preferimos el correcto si vino, sino el typo.
  const tripId = raw.trip_id || raw.tip_id || null;

  return {
    id:         `${ctx.feedSource}:${raw.id}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat:       raw.latitude,
      lng:       raw.longitude,
      bearing:   null, // GCBA Simple no expone bearing
      speed:     speedKmh,
      odometerM: null,
      altitudeM: null,
    },
    trip: {
      routeId:        raw.route_id,
      routeShortName: raw.route_short_name || null,
      tripId,
      startTime:      null,
      startDate:      null,
      headsign:       raw.trip_headsign || null,
      direction:      (typeof raw.direction === "number") ? raw.direction : null,
    },
    agency: (raw.agency_id || raw.agency_name) ? {
      id:   raw.agency_id || null,
      name: raw.agency_name || null,
    } : null,
    currentStopSequence: null,
    currentStopId:       null,
    currentStatus:       null, // GCBA Simple no expone
    congestionLevel:     null,
    enrichment:          null, // license_plate, make, model NO están en Simple
    timestamp:           raw.timestamp,
  };
}

/**
 * Maps respuesta completa del feed GCBA Simple a la lista canónica.
 *
 * @param {Array} rawArray - array directo de vehículos (lo que devuelve el endpoint)
 * @param {object} ctx - { cityId, mode, feedSource }
 * @returns {{ vehicles: Array, feedTimestamp: number|null }}
 */
function mapFeedToVehicles(rawArray, ctx) {
  // Validar shape global. Si falla, dejamos pasar lo que sí parsea
  // (tolerancia a vehiculos individuales con campos raros).
  const valid = [];
  const rejected = [];
  for (const raw of rawArray) {
    const parsed = GcbaVehicleRawSchema.safeParse(raw);
    if (parsed.success) {
      try {
        valid.push(mapGcbaVehicle(parsed.data, ctx));
      } catch (e) {
        rejected.push({ raw, reason: `mapper threw: ${e.message}` });
      }
    } else {
      rejected.push({ raw, reason: parsed.error.issues?.[0]?.message || "schema fail" });
    }
  }

  // Timestamp del feed: usar el max entre los vehículos (no hay header global)
  const timestamps = valid.map((v) => v.timestamp).filter((t) => t != null);
  const feedTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return {
    vehicles: valid,
    feedTimestamp,
    rejectedCount: rejected.length,
    sampleRejections: rejected.slice(0, 3),
  };
}

module.exports = {
  GcbaVehicleRawSchema,
  GcbaVehicleListRawSchema,
  mapGcbaVehicle,
  mapFeedToVehicles,
};
