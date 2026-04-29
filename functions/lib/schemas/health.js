/**
 * Schema canónico del endpoint /health.
 * Primera migración al formato API estándar — sirve como piloto del box.
 */

const { z } = require("zod");

const HealthSchema = z.object({
  stops:                z.number().int().nonnegative(),
  schedules:            z.number().int().nonnegative(),
  circuit:              z.enum(["closed", "open", "half-open"]),
  circuitFailures:      z.number().int().nonnegative(),
  busesCache:           z.enum(["hit", "miss"]),
  upcomingCacheSize:    z.number().int().nonnegative(),
  directionsCacheSize:  z.number().int().nonnegative(),
  rateLimitTracked:     z.number().int().nonnegative(),
  uptimeSeconds:        z.number().int().nonnegative(),
});

module.exports = { HealthSchema };
