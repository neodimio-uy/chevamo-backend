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
 * adapters dedicados con box sanitizador Zod (gcba.js, imm-stm.js, etc.).
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

// Mapping GTFS-RT Alert.Cause enum → string canónico Vamo `Incident.kind`.
// Tabla oficial: https://gtfs.org/realtime/reference/#enum-cause
const ALERT_CAUSE_MAP = {
  1: "unknown",         // UNKNOWN_CAUSE
  2: "other",           // OTHER_CAUSE
  3: "technical",       // TECHNICAL_PROBLEM
  4: "strike",          // STRIKE
  5: "demonstration",   // DEMONSTRATION
  6: "accident",        // ACCIDENT
  7: "holiday",         // HOLIDAY
  8: "weather",         // WEATHER
  9: "maintenance",     // MAINTENANCE
  10: "construction",   // CONSTRUCTION
  11: "police",         // POLICE_ACTIVITY
  12: "medical",        // MEDICAL_EMERGENCY
};

// Mapping GTFS-RT Alert.Effect enum → string canónico Vamo (informativo;
// se persiste como `effect` para que el cliente decida cómo renderear).
// Tabla oficial: https://gtfs.org/realtime/reference/#enum-effect
const ALERT_EFFECT_MAP = {
  1: "no_service",
  2: "reduced_service",
  3: "significant_delays",
  4: "detour",
  5: "additional_service",
  6: "modified_service",
  7: "other_effect",
  8: "unknown_effect",
  9: "stop_moved",
  10: "no_effect",
  11: "accessibility_issue",
};

// Mapping GTFS-RT SeverityLevel enum → string canónico Vamo.
// Tabla oficial: https://gtfs.org/realtime/reference/#enum-severitylevel
// `Incident.severity` del schema admin Vamo: low/medium/high/critical.
// SEVERE → high (no critical, reservamos critical para incidents que cierran
// líneas enteras por horas — el admin puede sobreescribir si corresponde).
const ALERT_SEVERITY_MAP = {
  1: "low",        // UNKNOWN_SEVERITY (informativo)
  2: "low",        // INFO
  3: "medium",     // WARNING
  4: "high",       // SEVERE
};

/**
 * Extrae el primer texto de una `TranslatedString` GTFS-RT. La spec permite
 * múltiples translations por idioma; tomamos español si está, sino el primero.
 *
 * @param {object|null} ts - TranslatedString del proto
 * @param {string} preferLang - código de idioma (default "es")
 * @returns {string} texto extraído o "" si no hay
 */
function extractText(ts, preferLang = "es") {
  if (!ts || !Array.isArray(ts.translation) || ts.translation.length === 0) return "";
  const preferred = ts.translation.find((t) => (t.language || "").toLowerCase().startsWith(preferLang));
  return (preferred?.text || ts.translation[0].text || "").trim();
}

/**
 * Convierte un timestamp protobuf (puede ser number o Long) a UNIX seconds.
 * Devuelve null si no es válido.
 */
function pbTimestamp(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  if (typeof v.toNumber === "function") {
    const n = v.toNumber();
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Mapea una `entity.alert` GTFS-RT al schema canónico Vamo Incident.
 * Devuelve null si la entity no tiene `alert` (es vehicle o trip_update).
 *
 * @param {object} entity - feedMessage.entity[i]
 * @param {object} ctx - { cityId, source } (ej `{ cityId: "ar.bue-caba", source: "sbase" }`)
 * @returns {object|null} Incident canonical o null
 */
function mapAlertEntity(entity, ctx) {
  if (!entity || !entity.alert) return null;
  const a = entity.alert;

  // Periodo activo: tomamos el primero. La spec permite múltiples ventanas
  // discontinuas pero raramente se usan; el cliente solo necesita "vigente
  // o no" y `start`/`end` para mostrar duración.
  const period = (a.active_period && a.active_period[0]) || {};
  const startedAt = pbTimestamp(period.start) ?? Math.floor(Date.now() / 1000);
  const endsAt = pbTimestamp(period.end);

  // Líneas y estaciones afectadas — extraemos solo IDs, el cliente resuelve
  // el display via su catálogo local.
  const affectedLines = [];
  const affectedStations = [];
  for (const sel of a.informed_entity || []) {
    if (sel.route_id) affectedLines.push(sel.route_id);
    if (sel.stop_id) affectedStations.push(sel.stop_id);
  }

  return {
    source: ctx.source,
    externalId: String(entity.id || ""),
    cityId: ctx.cityId,
    kind: ALERT_CAUSE_MAP[a.cause] || "unknown",
    effect: ALERT_EFFECT_MAP[a.effect] || "unknown_effect",
    severity: ALERT_SEVERITY_MAP[a.severity_level] || "medium",
    title: extractText(a.header_text),
    description: extractText(a.description_text),
    affectedLines: [...new Set(affectedLines)],
    affectedStations: [...new Set(affectedStations)],
    startedAt,
    endsAt,
    status: "active",
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Mapea un FeedMessage de alerts a la lista canónica. Filtra entities que no
 * sean alerts (vehicles, trip_updates) y normaliza.
 *
 * @param {Buffer|ArrayBuffer} buffer - feed protobuf crudo
 * @param {object} ctx - { cityId, source }
 * @returns {{ alerts: Array, feedTimestamp: number|null }}
 */
function mapFeedToAlerts(buffer, ctx) {
  const feed = decodeFeed(buffer);
  const entities = feed.entity || [];
  const alerts = entities
    .map((e) => mapAlertEntity(e, ctx))
    .filter((a) => a !== null);

  const feedTimestamp = feed.header?.timestamp
    ? (typeof feed.header.timestamp === "number"
        ? feed.header.timestamp
        : feed.header.timestamp.toNumber())
    : null;

  return { alerts, feedTimestamp };
}

module.exports = {
  decodeFeed,
  mapVehicleEntity,
  mapFeedToVehicles,
  mapAlertEntity,
  mapFeedToAlerts,
  STATUS_MAP,
  CONGESTION_MAP,
  ALERT_CAUSE_MAP,
  ALERT_EFFECT_MAP,
  ALERT_SEVERITY_MAP,
};
