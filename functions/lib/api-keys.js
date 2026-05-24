/**
 * Middleware de API keys per-consumer.
 *
 * Reemplaza Cloud API Gateway (que agregaba 200-500ms cross-region).
 * Validamos las 5 keys (`chevamo-ios-prod`, `chevamo-android-prod`,
 * `chevamo-web-dashboard`, `chevamo-web-data`, `chevamo-web-public`)
 * in-process, en el mismo Cloud Run que sirve el backend. Latencia
 * agregada <5ms.
 *
 * Storage: las 5 keys viven en Secret Manager (`chevamo-api-keys`,
 * region southamerica-east1, JSON `{ "<consumer>": "<keyString>" }`).
 * Lazy-load en cold start; cache en memoria por la vida de la
 * instance.
 *
 * **Modo monitor por default (`API_KEYS_ENFORCE != "true"`):**
 * loggeamos sample de requests sin key válida pero NO bloqueamos.
 * Permite deployar el código sin romper clientes legacy. Switch a
 * enforce cuando todos los clients (iOS, Android, 3 webs) hayan
 * agregado el header `X-API-Key`.
 *
 * **Identificación:** el consumer válido se expone como `req.consumer`
 * (string) y `req.apiKey` (objeto). Downstream handlers pueden usarlo
 * para per-consumer rate limit, telemetry, etc.
 *
 * **Whitelist:** endpoints con Firebase Auth propia (/me, /community,
 * /admin, /activity) NO requieren API key. Endpoints públicos sí.
 * La función `requiresApiKey(path)` lo determina por prefix.
 */

const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

const chevamoApiKeysSecret = defineSecret("chevamo-api-keys");

const ENFORCE = process.env.API_KEYS_ENFORCE === "true";

// keyString → consumer name. Lazy-loaded la primera vez que se valida
// una request. Si el secret no carga, todas las requests pasan sin
// validación (degradación graceful, NO romper backend).
let keyToConsumer = null;

const stats = {
  validHits: 0,
  invalidHits: 0,
  noKeyHits: 0,
  byConsumer: Object.create(null),
};

function loadKeys() {
  if (keyToConsumer) return keyToConsumer;
  try {
    const raw = chevamoApiKeysSecret.value();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const [consumer, keyString] of Object.entries(parsed)) {
      if (typeof keyString === "string" && keyString.length > 0) {
        map.set(keyString, consumer);
      }
    }
    keyToConsumer = map;
    logger.info(`api-keys loaded: ${map.size} consumers`);
    return keyToConsumer;
  } catch (e) {
    logger.warn(`api-keys load failed: ${e.message}`);
    return null;
  }
}

/**
 * Endpoints que requieren API key cuando ENFORCE=true.
 * NO incluye los que tienen Firebase Auth propia.
 */
function requiresApiKey(path) {
  if (!path) return false;
  // Excluidos: tienen su propio auth o son del sistema
  if (path.startsWith("/me/")) return false;
  if (path.startsWith("/community/")) return false;
  if (path.startsWith("/admin/")) return false;
  if (path.startsWith("/activity/")) return false;
  if (path.startsWith("/auth/")) return false;
  if (path === "/admin/briefing") return false;
  if (path === "/health" || path === "/__health" || path === "/_ah/health") return false;
  return true;
}

/**
 * Extrae la API key del request. Prioridad: header > query string.
 */
function extractKey(req) {
  const headerKey = req.headers["x-api-key"] || req.headers["X-API-Key"];
  if (typeof headerKey === "string" && headerKey.length > 0) return headerKey;
  const queryKey = req?.query?.key;
  if (typeof queryKey === "string" && queryKey.length > 0) return queryKey;
  return null;
}

/**
 * Valida la API key del request. Si ENFORCE=true y la key es inválida,
 * responde 401 y retorna false. Si ENFORCE=false (monitor mode),
 * loggea sample warning pero retorna true.
 *
 * El consumer válido queda en `req.consumer`. Downstream lo puede leer.
 *
 * @returns {boolean} true si el caller debe continuar procesando,
 *                    false si ya respondimos con 401.
 */
function requireApiKey(req, res, path) {
  if (!requiresApiKey(path)) return true; // whitelist: skip

  const keyMap = loadKeys();
  const presented = extractKey(req);

  if (!presented) {
    stats.noKeyHits++;
    if (ENFORCE) {
      res.status(401).json({
        ok: false,
        error: "API_KEY_REQUIRED",
        message: "Header 'X-API-Key' o query 'key' requerido",
      });
      return false;
    }
    if (Math.random() < 0.001) {
      logger.info(`api-keys: request sin key (monitor mode) path=${path} ua=${req.headers["user-agent"]?.slice(0, 80) || ""}`);
    }
    return true;
  }

  const consumer = keyMap ? keyMap.get(presented) : null;
  if (!consumer) {
    stats.invalidHits++;
    if (ENFORCE) {
      res.status(403).json({
        ok: false,
        error: "API_KEY_INVALID",
        message: "API key no reconocida",
      });
      return false;
    }
    if (Math.random() < 0.01) {
      logger.warn(`api-keys: key inválida (monitor mode) path=${path} prefix=${presented.slice(0, 8)}...`);
    }
    return true;
  }

  stats.validHits++;
  stats.byConsumer[consumer] = (stats.byConsumer[consumer] || 0) + 1;
  req.consumer = consumer;
  req.apiKey = { consumer, presented };
  return true;
}

function getApiKeyStats() {
  return {
    enforce: ENFORCE,
    loaded: !!keyToConsumer,
    knownConsumers: keyToConsumer ? Array.from(keyToConsumer.values()) : [],
    counters: { ...stats },
  };
}

module.exports = {
  requireApiKey,
  requiresApiKey,
  getApiKeyStats,
  chevamoApiKeysSecret,
};
