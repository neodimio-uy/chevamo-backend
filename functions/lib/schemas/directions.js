/**
 * Schemas canónicos de Directions (rutas multi-modales).
 * Cliente iOS: Route + RouteStep en Route.swift.
 */

const { z } = require("zod");

const RouteStepSchema = z.object({
  type:         z.enum(["bus", "walk"]),
  instruction:  z.string(),
  durationMin:  z.number().int().nonnegative(),
  distanceM:    z.number().int().nonnegative(),
  polyline:     z.string(),
  // Solo en transit — opcional, nullable
  line:         z.string().optional(),
  lineFullName: z.string().optional(),
  company:      z.string().optional(),
  headsign:     z.string().optional(),
  departureStop: z.string().optional(),
  arrivalStop:   z.string().optional(),
  departureTime: z.string().optional(),
  arrivalTime:   z.string().optional(),
  numStops:      z.number().int().nonnegative().optional(),
}).passthrough();

const RouteSchema = z.object({
  summary:           z.string(),
  totalDurationMin:  z.number().int().nonnegative(),
  totalDistanceM:    z.number().int().nonnegative(),
  departureTime:     z.string(),
  arrivalTime:       z.string(),
  startAddress:      z.string(),
  endAddress:        z.string(),
  polyline:          z.string(),
  steps:             z.array(RouteStepSchema),
});

const DirectionsResultSchema = z.object({
  routes: z.array(RouteSchema),
  status: z.string(),
});

module.exports = { RouteStepSchema, RouteSchema, DirectionsResultSchema };
