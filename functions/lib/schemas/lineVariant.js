/**
 * Schema canónico de una variante de línea.
 * `lineVariantId` mapea 1:1 a `shape_id` del GTFS — puente API↔polylines.
 */

const { z } = require("zod");

const LineVariantSchema = z.object({
  lineVariantId: z.number().int().nonnegative(),
  line:          z.string(),
  lineId:        z.number().int().nonnegative(),
  origin:        z.string().nullable().optional(),
  destination:   z.string().nullable().optional(),
  subline:       z.string().nullable().optional(),
  special:       z.boolean().optional().default(false),
}).passthrough();

module.exports = { LineVariantSchema };
