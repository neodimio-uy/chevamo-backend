/**
 * Schema canónico de un bus próximo a una parada (ETA oficial IMM).
 * Hardening 2026-04-17: coerce, trim, rangos semánticos.
 * Cliente iOS: UpcomingBus en Bus.swift.
 */

const { z } = require("zod");
const { GeoPointSchema } = require("./bus");

const UpcomingBusSchema = z.object({
  busId:          z.coerce.number().int().min(1).max(10_000_000).optional(),
  line:           z.string().trim().min(1).max(15),
  companyName:    z.string().trim().max(50).optional(),
  origin:         z.string().trim().max(200).nullable().optional(),
  destination:    z.string().trim().max(200).nullable().optional(),
  subline:        z.string().trim().max(200).nullable().optional(),
  special:        z.boolean().optional().default(false),
  // ETA en segundos: cap a 3600 (1 hora) — si viene más, probablemente error
  eta:            z.number().nonnegative().max(3600),
  // Distancia en metros: cap a 50km
  distance:       z.number().nonnegative().max(50_000),
  position:       z.number().int().nullable().optional(),
  access:         z.string().trim().max(50).nullable().optional(),
  thermalConfort: z.string().trim().max(50).nullable().optional(),
  emissions:      z.string().trim().max(50).nullable().optional(),
  location:       GeoPointSchema.nullable().optional(),
}).passthrough();

module.exports = { UpcomingBusSchema };
