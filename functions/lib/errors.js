/**
 * Catálogo CERRADO de error codes del box sanitizador.
 *
 * Cualquier error que sale del backend usa uno de estos codes.
 * Si un error no cuadra con ninguno, agregarlo acá — nunca inventar un code
 * ad-hoc en una ruta.
 *
 * El cliente (iOS/Android/Dashboard) tiene el mirror de este catálogo y lo
 * usa para decidir UI (ej: mostrar reintentar vs. mensaje de sistema caído).
 */

const ERROR_CODES = {
  INVALID_REQUEST:     { status: 400, message: "Pedido inválido" },
  UNAUTHORIZED:        { status: 401, message: "No autorizado" },
  FORBIDDEN:           { status: 403, message: "Acceso denegado" },
  NOT_FOUND:           { status: 404, message: "Recurso no encontrado" },
  RATE_LIMITED:        { status: 429, message: "Demasiadas solicitudes" },
  INTERNAL_ERROR:      { status: 500, message: "Error interno" },
  IMM_UNAVAILABLE:     { status: 502, message: "API de la IMM no disponible" },
  GOOGLE_UNAVAILABLE:  { status: 502, message: "API de Google no disponible" },
  FEED_UNAVAILABLE:    { status: 502, message: "Feed de transporte no disponible" },
  SERVICE_DEGRADED:    { status: 503, message: "Servicio con capacidad reducida" },
  METHOD_NOT_ALLOWED:  { status: 405, message: "Método HTTP no permitido" },
  PIPELINE_FAILED:     { status: 500, message: "Pipeline de procesamiento falló" },
};

module.exports = { ERROR_CODES };
