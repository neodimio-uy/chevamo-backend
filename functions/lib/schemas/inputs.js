/**
 * Schemas Zod para INPUTS de endpoints públicos. Cerramos vectores DoS
 * triviales (arrays gigantes en querystring, body sin tipo, etc) antes
 * de tocar lógica.
 *
 * Patrón: cada handler hace `Schema.safeParse(...)` al principio y
 * devuelve 400 con detalle si falla.
 */

const { z } = require("zod");

/**
 * `GET /buses/bylines?lines=159,121,494,...`
 * Limitado a 20 líneas por request — un cliente legítimo nunca pide más.
 * Cada código de línea hasta 8 chars (la línea más larga del STM tiene 6).
 */
const BusesByLinesInputSchema = z.object({
  lines: z.array(
    z.string().min(1).max(8).regex(/^[A-Za-z0-9]+$/)
  ).min(1).max(20),
});

/**
 * `GET /places/details?placeId=ChIJ...`
 * Google Places New IDs son alfanuméricos + `_-` hasta ~255 chars.
 * Bloqueamos path traversal (`..`), URL injection (`/?#`), etc.
 */
const PlacesDetailsInputSchema = z.object({
  placeId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
});

/**
 * `POST /directions`
 * Coords numéricas dentro de Uruguay (rango holgado UY + frontera AR/BR
 * — la validación geo más estricta `inBoundsUY` queda en el handler).
 * Modes opcionales: hoy solo "transit" implementado.
 */
const DirectionsInputSchema = z.object({
  fromLat: z.number().min(-90).max(90),
  fromLng: z.number().min(-180).max(180),
  toLat:   z.number().min(-90).max(90),
  toLng:   z.number().min(-180).max(180),
  mode:    z.enum(["transit", "walking", "bicycling", "driving"]).optional(),
});

module.exports = {
  BusesByLinesInputSchema,
  PlacesDetailsInputSchema,
  DirectionsInputSchema,
};
