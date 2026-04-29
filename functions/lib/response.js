/**
 * Response wrapper universal del box sanitizador.
 *
 * Todas las respuestas del backend pasan por `ok()` o `fail()`.
 * Formato estándar consumido por iOS/Android/Dashboard.
 *
 * Éxito: { ok: true, data, meta }
 * Error: { ok: false, error: { code, message } }
 */

const { ERROR_CODES } = require("./errors");

/**
 * Envía una respuesta de éxito.
 *
 * @param {express.Response} res
 * @param {any} data - payload ya saneado y validado por schema Zod
 * @param {object} meta - metadata opcional
 * @param {"imm"|"stm-online"|"cache"|"google"|"gtfs"|"computed"} meta.source
 * @param {boolean} meta.stale - true si se sirvió desde cache stale (fuente cayó)
 * @param {string} meta.cachedAt - ISO timestamp de cuando se cacheó
 * @param {number} meta.ttl - segundos de vida del dato
 * @param {number} meta.count - cantidad de items si es lista
 * @param {string} meta.version - versión del schema
 */
function ok(res, data, meta = {}) {
  const body = {
    ok: true,
    data,
    meta: {
      source: meta.source || "computed",
      stale: meta.stale === true,
      cachedAt: meta.cachedAt || new Date().toISOString(),
      ttl: typeof meta.ttl === "number" ? meta.ttl : 0,
      count: typeof meta.count === "number"
        ? meta.count
        : (Array.isArray(data) ? data.length : undefined),
      version: meta.version || "1",
    },
  };
  // Quitar undefined para JSON limpio
  if (body.meta.count === undefined) delete body.meta.count;

  return res.json(body);
}

/**
 * Envía una respuesta de error.
 *
 * @param {express.Response} res
 * @param {keyof typeof ERROR_CODES} code - code del catálogo cerrado
 * @param {string} [message] - override del mensaje (opcional, default es el del catálogo)
 */
function fail(res, code, message) {
  const spec = ERROR_CODES[code];
  if (!spec) {
    // Programador usó un code que no existe — fallar ruidosamente en dev,
    // degradar a INTERNAL_ERROR en prod para no tirar la Cloud Function.
    console.error(`fail(): unknown error code "${code}" — degrading to INTERNAL_ERROR`);
    const fallback = ERROR_CODES.INTERNAL_ERROR;
    return res.status(fallback.status).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: fallback.message },
    });
  }
  return res.status(spec.status).json({
    ok: false,
    error: {
      code,
      message: message || spec.message,
    },
  });
}

module.exports = { ok, fail };
