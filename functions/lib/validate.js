/**
 * Validadores del box sanitizador.
 *
 * - `validateList` procesa arrays de forma permisiva: items inválidos se
 *   filtran con log — no tiran toda la respuesta. Ideal para /buses,
 *   /busstops, /upcoming donde la IMM puede mandar un bus roto entre 500 buenos.
 * - `validateObject` es estricto: si falla, el endpoint devuelve INTERNAL_ERROR.
 */

const { logger } = require("firebase-functions");

/**
 * Valida cada item de un array contra un schema Zod.
 * Items que fallan se loguean y descartan. Retorna los válidos + metadata.
 */
function validateList(schema, items, label = "list") {
  if (!Array.isArray(items)) {
    logger.warn(`${label}: expected array, got ${typeof items}`);
    return { valid: [], rejected: 0 };
  }
  const valid = [];
  let rejected = 0;
  const firstErrors = [];

  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      rejected++;
      if (firstErrors.length < 3) {
        firstErrors.push(parsed.error.issues?.[0]?.message || parsed.error.message);
      }
    }
  }

  if (rejected > 0) {
    logger.warn(`${label}: ${rejected}/${items.length} items rejected. Samples: ${firstErrors.join(" | ")}`);
  }

  return { valid, rejected };
}

/**
 * Valida un objeto contra un schema. Devuelve `{ ok: true, data }` o `{ ok: false, error }`.
 */
function validateObject(schema, obj, label = "object") {
  const parsed = schema.safeParse(obj);
  if (parsed.success) return { ok: true, data: parsed.data };
  logger.error(`${label}: schema validation failed: ${parsed.error.message}`);
  return { ok: false, error: parsed.error.message };
}

module.exports = { validateList, validateObject };
