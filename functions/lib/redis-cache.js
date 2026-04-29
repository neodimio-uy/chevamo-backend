/**
 * L2 cache: Memorystore Redis compartido entre instancias.
 *
 * Diseño:
 * - L1: cache in-memory por instancia (RequestCache en index.js, ya existe)
 * - L2: Redis compartido — si una instancia recién levantada tiene L1 vacío,
 *   chequea L2 antes de salir al gobierno upstream.
 * - Fallback total: si Redis no está disponible, todo sigue funcionando solo
 *   con L1. Cero hard dependency.
 *
 * Variables de entorno:
 *   REDIS_HOST  — IP privada de Memorystore (ej. 10.x.x.x)
 *   REDIS_PORT  — default 6379
 *
 * Si REDIS_HOST no está seteado o el client no conecta en 5s, modo bypass.
 */

const Redis = require("ioredis");
const { logger } = require("firebase-functions");

const REDIS_HOST = process.env.REDIS_HOST || "";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

let client = null;
let lastErrorLoggedAt = 0;

function getClient() {
  if (!REDIS_HOST) return null;
  if (client) return client;

  client = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,    // no reintentar agresivamente, mejor caer a L1
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => {
      // Backoff exponencial hasta 30s. Tras eso, mantener intervalo
      return Math.min(times * 1_000, 30_000);
    },
    reconnectOnError: () => true,
  });

  client.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorLoggedAt > 60_000) {
      logger.warn(`Redis L2 error (modo bypass activo): ${err.message}`);
      lastErrorLoggedAt = now;
    }
  });
  client.on("ready", () => logger.info("Redis L2 conectado"));
  return client;
}

/**
 * Lee de Redis. Devuelve null si no hay client, key, o el cliente está caído.
 * @returns {Promise<{data,etag,expiry,cachedAt,ttl}|null>}
 */
async function getEntry(namespace, key) {
  const c = getClient();
  if (!c || c.status !== "ready") return null;
  try {
    const raw = await c.get(`vamo:${namespace}:${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() >= entry.expiry) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Escribe a Redis. Fire-and-forget — no bloquea el response al cliente.
 */
function setEntry(namespace, key, entry, ttlMs) {
  const c = getClient();
  if (!c || c.status !== "ready") return;
  const fullKey = `vamo:${namespace}:${key}`;
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  c.setex(fullKey, ttlSec, JSON.stringify(entry)).catch(() => {});
}

function isReady() {
  const c = getClient();
  return Boolean(c && c.status === "ready");
}

module.exports = { getEntry, setEntry, isReady };
