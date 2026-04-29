/**
 * Adapter GENÉRICO para feeds GTFS-Realtime estándar (Protocol Buffers).
 *
 * Maneja cualquier feed que cumpla con la especificación GTFS-RT v1.0
 * (https://gtfs.org/realtime/reference/). Una sola implementación sirve
 * para todos los feeds compatibles — sumar ciudad nueva = registrar URL
 * en `cities.js` + `registry.js`, NO escribir adapter custom.
 *
 * Maps:
 *   feedMessage.entity[].vehicle  → VehicleSchema (canonical-vehicle.js)
 *   feedMessage.entity[].alert    → ServiceAlert (futuro)
 *   feedMessage.entity[].trip_update → TripUpdate (futuro)
 *
 * Usa `gtfs-realtime-bindings` oficial (Google + MobilityData).
 *
 * Para feeds NO estándar (custom JSON, PascalCase, schemas propios), usar
 * adapters dedicados con box sanitizador Zod (gcba.js, cm-lisboa.js, etc.).
 */

const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const { transit_realtime } = GtfsRealtimeBindings;

// Mapping GTFS-RT VehicleStopStatus enum → string canónico
const STATUS_MAP = {
  0: "incoming_at",
  1: "stopped_at",
  2: "in_transit_to",
  3: "unknown",
};

// Mapping GTFS-RT CongestionLevel enum → string canónico
const CONGESTION_MAP = {
  0: "unknown",
  1: "running_smoothly",
  2: "stop_and_go",
  3: "congestion",
  4: "severe",
};

/**
 * Decodifica un buffer protobuf GTFS-RT a FeedMessage.
 * Lanza si el buffer no es válido GTFS-RT.
 */
function decodeFeed(buffer) {
  return transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

/**
 * Convierte un slot `entity.vehicle` (GTFS-RT) al schema canónico Vamo.
 * Devuelve null si la entity no tiene `vehicle` (ej es alert o trip_update).
 *
 * @param {object} entity - feedMessage.entity[i]
 * @param {object} ctx    - { cityId, mode, feedSource } para anotar el dato
 */
function mapVehicleEntity(entity, ctx) {
  if (!entity || !entity.vehicle) return null;
  const vp = entity.vehicle;

  // Posición — GTFS-RT trae lat/lng/speed/bearing/odometer
  const pos = vp.position || {};
  const speedMps = (typeof pos.speed === "number") ? pos.speed : null;
  // GTFS-RT especifica `speed` en m/s. Normalizamos a km/h para que el cliente
  // tenga un único unit. Si vendrá negativo o NaN, lo dejamos null.
  const speedKmh = (speedMps != null && Number.isFinite(speedMps) && speedMps >= 0)
    ? Math.round(speedMps * 3.6 * 10) / 10
    : null;

  const trip = vp.trip || null;

  return {
    id:         `${ctx.feedSource}:${vp.vehicle?.id || entity.id || "unknown"}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat:       pos.latitude ?? 0,
      lng:       pos.longitude ?? 0,
      bearing:   (typeof pos.bearing === "number") ? pos.bearing : null,
      speed:     speedKmh,
      odometerM: (typeof pos.odometer === "number" && pos.odometer >= 0) ? pos.odometer : null,
      altitudeM: null, // GTFS-RT no expone altitude estándar
    },
    trip: trip ? {
      routeId:        trip.route_id || trip.routeId || "",
      routeShortName: null, // GTFS-RT estándar no lo trae; lookup contra GTFS estático en cliente
      tripId:         trip.trip_id || trip.tripId || null,
      startTime:      trip.start_time || trip.startTime || null,
      startDate:      trip.start_date || trip.startDate || null,
      headsign:       null,
      direction:      (typeof trip.direction_id === "number") ? trip.direction_id : null,
    } : null,
    agency: null, // GTFS-RT estándar no incluye agency en vehicle entity
    currentStopSequence: (typeof vp.current_stop_sequence === "number") ? vp.current_stop_sequence : null,
    currentStopId:       vp.stop_id || null,
    currentStatus:       STATUS_MAP[vp.current_status] || null,
    congestionLevel:     CONGESTION_MAP[vp.congestion_level] || null,
    enrichment: vp.vehicle ? {
      licensePlate:        vp.vehicle.license_plate || null,
      make:                null, // GTFS-RT no estándar
      model:               null,
      propulsion:          null,
      capacityTotal:       null,
      capacitySeated:      null,
      wheelchairAccessible: null,
      bikesAllowed:        null,
      registrationDate:    null,
    } : null,
    timestamp: (typeof vp.timestamp === "number" || typeof vp.timestamp?.toNumber === "function")
      ? (typeof vp.timestamp === "number" ? vp.timestamp : vp.timestamp.toNumber())
      : null,
  };
}

/**
 * Mapea un FeedMessage completo a la lista canónica.
 *
 * @param {Buffer|ArrayBuffer} buffer - feed protobuf crudo
 * @param {object} ctx - { cityId, mode, feedSource }
 * @returns {{ vehicles: Array, feedTimestamp: number|null }}
 */
function mapFeedToVehicles(buffer, ctx) {
  const feed = decodeFeed(buffer);
  const entities = feed.entity || [];
  const vehicles = entities
    .map((e) => mapVehicleEntity(e, ctx))
    .filter((v) => v !== null);

  const feedTimestamp = feed.header?.timestamp
    ? (typeof feed.header.timestamp === "number"
        ? feed.header.timestamp
        : feed.header.timestamp.toNumber())
    : null;

  return { vehicles, feedTimestamp };
}

module.exports = {
  decodeFeed,
  mapVehicleEntity,
  mapFeedToVehicles,
  STATUS_MAP,
  CONGESTION_MAP,
};
