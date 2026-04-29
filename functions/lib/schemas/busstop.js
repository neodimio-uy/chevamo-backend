/**
 * Schema canónico de una parada de bus.
 * Hardening 2026-04-17: coerce IDs, trim strings, rango geográfico.
 * Cliente iOS: BusStop en Bus.swift.
 */

const { z } = require("zod");
const { GeoPointSchema } = require("./bus");

const BusStopSchema = z.object({
  busstopId: z.coerce.number().int().min(1).max(1_000_000),
  street1:   z.string().trim().max(200).nullable().optional(),
  street2:   z.string().trim().max(200).nullable().optional(),
  location:  GeoPointSchema,
}).passthrough().refine(
  // Al menos una calle debe estar presente — parada sin nombre es error
  (stop) => (stop.street1 && stop.street1.length > 0) || (stop.street2 && stop.street2.length > 0),
  { message: "Parada sin nombre de calle" }
);

module.exports = { BusStopSchema };
