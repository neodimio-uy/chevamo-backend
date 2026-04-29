/**
 * Schema canónico de un vehículo en vivo (versión multi-ciudad / multi-modo
 * de Vamo, post-decisión 2026-04-26 de Super App).
 *
 * Este schema es el contrato común que TODOS los adapters de feed (IMM, MTOP,
 * GCBA, CM Lisboa, GTFS-RT genérico, etc.) deben producir tras pasar por su
 * box sanitizador. El cliente iOS consume esta shape vía `Vehicle` protocol
 * (TransitVehicle).
 *
 * Diferencia con `BusSchema` viejo (`bus.js`):
 *   - Bbox geográfico configurable por ciudad (no hardcodeado a Uruguay)
 *   - `mode` explícito (bus / subte / bike / tren / ferry)
 *   - `feedSource` para trazabilidad (qué adapter produjo el dato)
 *   - Campos opcionales para enriquecimientos de feeds que los traen
 *     (license_plate / make / model / propulsion / wheelchair / capacity)
 *   - `currentStatus` y `congestionLevel` GTFS-Realtime estándar
 *
 * NO usar este schema directo desde adapters — cada adapter tiene su propio
 * schema de input (validar lo que viene del backend externo) + un mapper a
 * este schema canónico.
 */

const { z } = require("zod");

// Los modos de transporte que Vamo soporta. Mantener alineado con el enum
// `TransitMode` del cliente iOS.
const VehicleModeSchema = z.enum([
  "bus",
  "subte",   // metro / underground
  "bike",    // bicicletas públicas (formato GBFS)
  "tren",    // commuter rail / regional rail
  "ferry",
  "scooter", // futuro
  "auto",    // futuro (ride-hailing aggregator)
  "taxi",    // taxis tradicionales (paradas oficiales + community)
  "remis",   // remís (Argentina, UY interior)
]);

// GTFS-Realtime VehicleStopStatus enum (0..3)
const CurrentStatusSchema = z.enum([
  "incoming_at",  // 0
  "stopped_at",   // 1
  "in_transit_to", // 2
  "unknown",       // 3
]);

// GTFS-Realtime CongestionLevel enum (0..4)
const CongestionLevelSchema = z.enum([
  "unknown",
  "running_smoothly",
  "stop_and_go",
  "congestion",
  "severe",
]);

// Sub-shape: posición geográfica con extras opcionales.
const VehiclePositionSchema = z.object({
  lat:        z.number().min(-90).max(90),
  lng:        z.number().min(-180).max(180),
  bearing:    z.number().min(0).max(360).nullable().optional(), // grados desde N
  speed:      z.number().min(0).max(250).nullable().optional(), // km/h (normalizado por adapter)
  odometerM:  z.number().nonnegative().nullable().optional(),
  altitudeM:  z.number().nullable().optional(),
});

// Sub-shape: trip activo (cuál ruta y qué viaje específico está sirviendo).
// Tanto `routeId` como `tripId` son opcionales — algunos feeds publican uno
// u otro (ej Renfe LD solo emite tripId, otros solo routeId). El adapter
// debe asegurar que al menos uno esté presente; los consumidores prefieren
// `routeShortName` para display y caen a `routeId`/`tripId` como fallback.
const VehicleTripSchema = z.object({
  routeId:        z.string().trim().max(100).nullable().optional(),
  routeShortName: z.string().trim().max(50).nullable().optional(), // "60", "159C"
  tripId:         z.string().trim().nullable().optional(),
  startTime:      z.string().trim().nullable().optional(), // "13:15:00"
  startDate:      z.string().trim().nullable().optional(), // "20260426"
  headsign:       z.string().trim().max(200).nullable().optional(),
  direction:      z.number().int().min(0).max(1).nullable().optional(),
});

// Sub-shape: agencia / operadora.
const VehicleAgencySchema = z.object({
  id:   z.string().trim().nullable().optional(),
  name: z.string().trim().max(100).nullable().optional(),
});

// Sub-shape: enriquecimientos del vehículo físico (feeds que los traen, ej Lisboa).
const VehicleEnrichmentSchema = z.object({
  licensePlate:        z.string().trim().max(30).nullable().optional(),
  make:                z.string().trim().max(50).nullable().optional(),
  model:               z.string().trim().max(50).nullable().optional(),
  propulsion:          z.enum([
    "electricity", "diesel", "hybrid", "natural_gas", "lpg_auto", "hydrogen", "unknown",
  ]).nullable().optional(),
  capacityTotal:       z.number().int().min(0).max(500).nullable().optional(),
  capacitySeated:      z.number().int().min(0).max(500).nullable().optional(),
  wheelchairAccessible: z.boolean().nullable().optional(),
  bikesAllowed:        z.boolean().nullable().optional(),
  registrationDate:    z.string().trim().nullable().optional(),
});

const VehicleSchema = z.object({
  // Identidad
  id:           z.string().trim().min(1).max(100),  // `<feed>:<vehicleId>` para evitar colisiones
  feedSource:   z.string().trim().min(1).max(50),    // ej "imm-stm", "gcba-vehicles-simple"
  cityId:       z.string().trim().min(1).max(50),    // ej "uy.mvd-area-metro"
  mode:         VehicleModeSchema,

  // Posición
  position:     VehiclePositionSchema,

  // Trip (cuando se conoce — algunos feeds no exponen)
  trip:         VehicleTripSchema.nullable().optional(),

  // Agencia operadora
  agency:       VehicleAgencySchema.nullable().optional(),

  // Estado en ruta (GTFS-RT estándar)
  currentStopSequence: z.number().int().min(0).nullable().optional(),
  currentStopId:       z.string().trim().nullable().optional(),
  currentStatus:       CurrentStatusSchema.nullable().optional(),
  congestionLevel:     CongestionLevelSchema.nullable().optional(),

  // Enriquecimientos físicos (Lisboa los trae todos, otros menos)
  enrichment:   VehicleEnrichmentSchema.nullable().optional(),

  // Timestamp del feed (POSIX seconds)
  timestamp:    z.number().int().nullable().optional(),
});

// Lista de vehículos — el cliente recibe esto envuelto en `{ ok, data, meta }`.
const VehicleListSchema = z.object({
  vehicles: z.array(VehicleSchema),
  cityId:   z.string(),
  mode:     VehicleModeSchema,
  service:  z.string().nullable().optional(),
  feedTimestamp: z.number().int().nullable().optional(),
});

module.exports = {
  VehicleSchema,
  VehicleListSchema,
  VehicleModeSchema,
  CurrentStatusSchema,
  CongestionLevelSchema,
  VehiclePositionSchema,
  VehicleTripSchema,
  VehicleAgencySchema,
  VehicleEnrichmentSchema,
};
