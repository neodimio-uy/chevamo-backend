/**
 * Schemas Zod para el modo Taxi/Remis (Vamo marketplace propio).
 *
 * Vamo opera flota asociada autorizada por jurisdicción. Los drivers se
 * registran via cooperativas locales (operators con kind "fleet-cooperative").
 *
 * Etapa 1 (2026-04-27): solo schemas + Firestore docs + endpoint stubs.
 * Lógica de matching, payments y driver app son post-launch.
 *
 * Ver `project_vamo_taxi_remis.md` para plan completo.
 */

const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Geo
// ─────────────────────────────────────────────────────────────────────────────

const CoordSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

const PlaceSchema = z.object({
  coord:          CoordSchema,
  address:        z.string().min(1).max(500),
  jurisdictionId: z.string().min(1).max(50),
  placeId:        z.string().optional().nullable(),  // Google Place ID si vino del autocompleter
});

// ─────────────────────────────────────────────────────────────────────────────
// Driver + Vehicle
// ─────────────────────────────────────────────────────────────────────────────

const ServiceKindSchema = z.enum(["taxi", "remis", "moto"]);

const DriverStatusSchema = z.enum([
  "pending_verification",  // se registró, falta admin approval
  "active",                // approved, puede ir online
  "suspended",             // bloqueado por admin (rating bajo, dispute, etc.)
  "off-duty",              // active pero offline
]);

const VehicleSchema = z.object({
  id:                  z.string(),
  driverId:            z.string(),
  plate:               z.string().min(2).max(15),
  model:               z.string(),
  color:               z.string(),
  year:                z.number().int().min(1980).max(2100),
  kind:                z.string(),  // "taxi-tradicional", "remis-sedan", "moto-honda", etc.
  inspectionExpiresAt: z.string().datetime().optional().nullable(),  // ISO8601
  photos:              z.array(z.string().url()).default([]),
});

const DriverSchema = z.object({
  id:                  z.string(),
  userId:              z.string(),                // ref a users/{userId}
  jurisdictionId:      z.string(),                // ej "uy.mvd"
  operatorId:          z.string(),                // ref a operator (cooperativa)
  serviceKind:         ServiceKindSchema,
  licenseNumber:       z.string().min(1).max(50),
  documentVerified:    z.boolean().default(false),
  documentVerifiedAt:  z.string().datetime().optional().nullable(),
  status:              DriverStatusSchema.default("pending_verification"),
  rating:              z.object({
    avg:   z.number().gte(0).lte(5),
    count: z.number().int().nonnegative(),
  }).default({ avg: 0, count: 0 }),
  totalTrips:          z.number().int().nonnegative().default(0),
  currentVehicleId:    z.string().optional().nullable(),
  liveSession:         z.object({
    online:        z.boolean(),
    position:      CoordSchema.optional().nullable(),
    lastUpdate:    z.string().datetime().optional().nullable(),
    currentTripId: z.string().optional().nullable(),
  }).optional().nullable(),
});

// ─────────────────────────────────────────────────────────────────────────────
// RideRequest
// ─────────────────────────────────────────────────────────────────────────────

const RideRequestStatusSchema = z.enum([
  "searching",                // creado, buscando driver
  "matched",                  // sistema asignó driver, esperando accept
  "driver_accepted",          // driver aceptó, viene al pickup
  "driver_arrived",           // driver llegó al pickup, esperando passenger
  "in_progress",              // viaje en marcha
  "completed",                // terminó OK, ratings opcionales
  "cancelled_by_passenger",
  "cancelled_by_driver",
  "no_drivers_available",     // 60s sin matches → cancelado por sistema
]);

const FareEstimateSchema = z.object({
  min:      z.number().int().nonnegative(),  // cents
  max:      z.number().int().nonnegative(),
  currency: z.string().length(3),            // ISO 4217
});

// "cash" = efectivo al driver
// "mercadopago" = a través de Mercado Pago (genérico — la sub-elección de
//                 tarjeta vs cuenta MP la hace el cliente con `paymentCardId`
//                 (cardId guardada en MP customer) o "account_money" string)
// "stm-card"   = futuro: pagar con tarjeta STM (UY) cuando IMM lo permita
const PaymentMethodSchema = z.enum(["cash", "mercadopago", "stm-card"]);

const RideTimelineEventSchema = z.object({
  event: z.string(),
  at:    z.string().datetime(),
  by:    z.string().optional().nullable(),  // userId del actor
  meta:  z.record(z.unknown()).optional().nullable(),
});

const RideRequestSchema = z.object({
  id:               z.string(),
  passengerId:      z.string(),
  origin:           PlaceSchema,
  destination:      PlaceSchema,
  serviceKind:      ServiceKindSchema,
  requestedAt:      z.string().datetime(),
  status:           RideRequestStatusSchema.default("searching"),
  matchedDriverId:  z.string().optional().nullable(),
  matchedVehicleId: z.string().optional().nullable(),
  fareEstimate:     FareEstimateSchema,
  fareFinal:        z.number().int().nonnegative().optional().nullable(),
  paymentMethod:    PaymentMethodSchema.default("cash"),
  paymentStatus:    z.enum(["pending", "paid", "disputed"]).default("pending"),
  timeline:         z.array(RideTimelineEventSchema).default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Trip (snapshot inmutable post-completion)
// ─────────────────────────────────────────────────────────────────────────────

const TripSchema = z.object({
  id:               z.string(),
  rideRequestId:    z.string(),
  passengerId:      z.string(),
  driverId:         z.string(),
  jurisdictionId:   z.string(),
  completedAt:      z.string().datetime(),
  distanceMeters:   z.number().int().nonnegative(),
  durationSeconds:  z.number().int().nonnegative(),
  gpsPath:          z.array(CoordSchema).default([]),  // downsampled
  fareBreakdown:    z.object({
    base:       z.number().int().nonnegative(),
    distance:   z.number().int().nonnegative(),
    time:       z.number().int().nonnegative(),
    surcharges: z.number().int().nonnegative(),
    total:      z.number().int().nonnegative(),
    currency:   z.string().length(3),
  }),
  passengerRating:  z.object({
    score:   z.number().int().min(1).max(5),
    comment: z.string().max(500).optional().nullable(),
  }).optional().nullable(),
  driverRating:     z.object({
    score:   z.number().int().min(1).max(5),
    comment: z.string().max(500).optional().nullable(),
  }).optional().nullable(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inputs de endpoints HTTP (request body / query)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /rides` — crear ride request.
 * Passenger envía origen + destino + tipo. Sistema persiste con status="searching"
 * y devuelve el requestId. Etapa 1 NO arranca matching — solo persistencia.
 */
const CreateRideInputSchema = z.object({
  origin:        PlaceSchema,
  destination:   PlaceSchema,
  serviceKind:   ServiceKindSchema,
  paymentMethod: PaymentMethodSchema.default("cash"),
  // Si paymentMethod=="mercadopago": cuál sub-método dentro de MP.
  //   - cardId guardado: ej "1234567890" (MP card.id) → charge con esa tarjeta
  //   - "account_money": cobrar dinero en cuenta MP del passenger
  // Si paymentMethod=="cash": ignorado.
  paymentCardId: z.string().optional().nullable(),
});

/**
 * `POST /rides/:id/cancel` — passenger cancela
 */
const CancelRideInputSchema = z.object({
  reason: z.string().max(500).optional(),
});

/**
 * `POST /rides/:id/rate` — rating del passenger al driver post-trip
 */
const RateRideInputSchema = z.object({
  score:   z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

module.exports = {
  // Sub-schemas
  CoordSchema,
  PlaceSchema,
  ServiceKindSchema,
  DriverStatusSchema,
  RideRequestStatusSchema,
  FareEstimateSchema,
  PaymentMethodSchema,
  RideTimelineEventSchema,
  // Entity schemas
  VehicleSchema,
  DriverSchema,
  RideRequestSchema,
  TripSchema,
  // Endpoint input schemas
  CreateRideInputSchema,
  CancelRideInputSchema,
  RateRideInputSchema,
};
