/**
 * Schema canónico de un bus en vivo (posición GPS).
 *
 * Hardening 2026-04-17:
 * - `.coerce` en IDs numéricos: acepta int o string parseable como int
 * - `.trim()` en strings: elimina whitespace invisible
 * - Rangos semánticos (`.min/.max`): rechaza outliers
 * - Refinement geográfico: coords deben caer en Uruguay + margen
 *
 * Fuentes: IMM API (`/buses`) y stm-online (fallback).
 * Cliente iOS: Bus.swift.
 */

const { z } = require("zod");

// Uruguay continental + margen generoso. Rechaza null island, [-258,-258],
// y cualquier coord fuera de la región.
const URUGUAY_LAT_MIN = -36;
const URUGUAY_LAT_MAX = -29;
const URUGUAY_LNG_MIN = -59;
const URUGUAY_LNG_MAX = -52;

const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.array(z.number()).length(2),
}).refine(
  (p) => {
    const [lng, lat] = p.coordinates;
    return (
      Number.isFinite(lng) && Number.isFinite(lat) &&
      lng >= URUGUAY_LNG_MIN && lng <= URUGUAY_LNG_MAX &&
      lat >= URUGUAY_LAT_MIN && lat <= URUGUAY_LAT_MAX
    );
  },
  { message: "Coordenadas fuera del rango Uruguay" }
);

const BusSchema = z.object({
  busId:          z.coerce.number().int().min(1).max(10_000_000),
  line:           z.string().trim().min(1).max(15),
  company:        z.string().trim().min(1).max(50),
  destination:    z.string().trim().max(200).nullable().optional(),
  origin:         z.string().trim().max(200).nullable().optional(),
  subline:        z.string().trim().max(200).nullable().optional(),
  speed:          z.number().min(0).max(150).nullable().optional(),
  emissions:      z.string().trim().max(50).nullable().optional(),
  thermalConfort: z.string().trim().max(50).nullable().optional(),
  access:         z.string().trim().max(50).nullable().optional(),
  location:       GeoPointSchema,
  lineVariantId:  z.coerce.number().int().min(1).max(100_000),
}).passthrough();

module.exports = { BusSchema, GeoPointSchema };
