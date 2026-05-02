const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten, onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { setGlobalOptions, params } = require("firebase-functions/v2");
const defineSecret = params.defineSecret;
const { logger } = require("firebase-functions");
// Cloud Profiler — perfilado continuo low-overhead (CPU + heap) en producción.
// Solo en runtime de Cloud Run (K_REVISION presente). Durante `firebase deploy`
// el analyzer corre el index.js sin K_REVISION → pprof bindings nativos
// pueden no estar disponibles → MODULE_NOT_FOUND. Try/catch protege.
if (process.env.K_REVISION) {
  try {
    require("@google-cloud/profiler").start({
      serviceContext: { service: "vamo-api", version: process.env.K_REVISION },
    }).catch(() => { /* no bloquear si profiler falla */ });
  } catch (e) {
    // Profiler no disponible (build env, missing native bindings) — ignorar.
  }
}

const axios = require("axios");
const http = require("http");
const https = require("https");
const { PubSub } = require("@google-cloud/pubsub");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// HTTP keep-alive — reusa conexiones TCP+TLS a upstreams (IMM, AMBA, Lisboa, Google APIs).
// Ahorra ~100-300ms de handshake por call. Como axios cachea require(), todos los adapters
// que hacen `require("axios")` heredan estos defaults.
const keepAliveHttpAgent  = new http.Agent({ keepAlive: true,  maxSockets: 50, maxFreeSockets: 10, timeout: 60_000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 60_000 });
axios.defaults.httpAgent  = keepAliveHttpAgent;
axios.defaults.httpsAgent = keepAliveHttpsAgent;

// ─────────────────────────────────────────────────────────────────
// Pub/Sub singleton para writes fire-and-forget.
// Endpoints como /user/fcm-token o /activity/register publican aquí
// y devuelven 200 inmediato. La función `onAsyncWrite` consume y escribe
// a Firestore en background. Latencia user-facing: ~50ms vs ~558ms.
// ─────────────────────────────────────────────────────────────────
const pubsubClient = new PubSub();
const ASYNC_WRITES_TOPIC = "vamo-async-writes";

/** Publica un mensaje fire-and-forget. NO bloquea el response al cliente. */
function publishAsyncWrite(kind, payload) {
  const data = Buffer.from(JSON.stringify({ kind, payload, ts: Date.now() }));
  return pubsubClient.topic(ASYNC_WRITES_TOPIC).publishMessage({ data })
    .catch((err) => logger.warn(`publishAsyncWrite ${kind} error: ${err.message}`));
}

// Box sanitizador: response wrapper + schemas canónicos + errores + validadores
const { ok, fail } = require("./lib/response");
const schemas = require("./lib/schemas");
const { validateList, validateObject } = require("./lib/validate");
const { extractAuth, requireAdminEmail } = require("./lib/auth");
const staticFeeds = require("./lib/static-feeds");
const staticGtfsPipeline = require("./lib/pipelines/static-gtfs");
const { ack } = require("./lib/schemas/ack");
const {
  adaptCurrent: adaptWeatherCurrent,
  adaptForecastHourly: adaptWeatherForecastHourly,
  adaptForecastDaily: adaptWeatherForecastDaily,
} = require("./lib/adapters/googleWeather");
const {
  adaptCurrentConditions: adaptAirQuality,
} = require("./lib/adapters/googleAirQuality");

// Multi-ciudad / multi-modo (Milestone 1 Foundation 2026-04-26)
const cityRegistry = require("./lib/cities");
const adapterRegistry = require("./lib/adapters/registry");

// Modelo Jurisdiction + MetroArea + NationalNetwork + Operator (Fase 2 — 2026-04-27)
// Convive con cityRegistry durante la transición (cities.js se elimina en 2.E).
const jurisdictionRegistry = require("./lib/jurisdictions");
const metroAreaRegistry = require("./lib/metro-areas");
const nationalNetworkRegistry = require("./lib/national-networks");
const operatorRegistry = require("./lib/operators");
const transportGraph = require("./lib/transport-graph");

// Adapters dedicados para feeds que no encajan en TransitVehicle:
//   - Subte forecast: arrival predictions sin GPS (TripUpdate-like)
//   - Ecobici GBFS:   estaciones de docking (BikeStation-like)
const gcbaSubte   = require("./lib/adapters/gcba-subte");
const gcbaEcobici = require("./lib/adapters/gcba-ecobici");

// Modo Taxi/Remis (Vamo marketplace propio — Etapa 1 stubs 2026-04-27)
const rideSchemas = require("./lib/ride-hailing/schemas");

// Mercado Pago Checkout API — payments + wallet multi-país (UY/AR/BR)
// Wrapper en `lib/payments/mercadopago.js`. Modo MOCK cuando no hay access
// token (preview visual sin cobrar) — útil pre-launch.
const mp = require("./lib/payments/mercadopago");

// Default region: sa-east1 (mismo que Firestore — evita 125ms cross-Atlantic por call)
// Override explícito en `runStaticGtfsPipeline` para que se quede en us-central1
// porque depende del bucket vamo-gtfs-snapshots que vive ahí.
setGlobalOptions({ region: "southamerica-east1" });

// Google Maps API key desde Secret Manager — nunca en código
const googleMapsKey = defineSecret("GOOGLE_MAPS_KEY");
const immClientSecret = defineSecret("IMM_CLIENT_SECRET");
// Credenciales GCBA (Buenos Aires) — Secret Manager
const baTransportClientId     = defineSecret("BA_TRANSPORT_CLIENT_ID");
const baTransportClientSecret = defineSecret("BA_TRANSPORT_CLIENT_SECRET");
// Mercado Pago Access Tokens — uno por país. Si no se setean en Secret
// Manager, el wrapper opera en MODO MOCK (devuelve {status:"approved"} sin
// cobrar). Esto permite preview visual antes de generar credenciales reales.
const mpAccessTokenUY = defineSecret("MP_ACCESS_TOKEN_UY");
const mpAccessTokenAR = defineSecret("MP_ACCESS_TOKEN_AR");
const mpAccessTokenBR = defineSecret("MP_ACCESS_TOKEN_BR");
const mpWebhookSecret = defineSecret("MP_WEBHOOK_SECRET");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const GOOGLE_PLACES_NEW_BASE = "https://places.googleapis.com/v1";
const GOOGLE_DIRECTIONS_BASE = "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_WEATHER_BASE    = "https://weather.googleapis.com/v1";

// Grid para cachear clima por celda (~2 km en Uruguay).
// 1° lat = ~111 km → 0.018° ≈ 2 km.
// A latitud -34.9°, 1° lng = ~91 km → 0.022° ≈ 2 km.
const WEATHER_GRID_LAT = 0.018;
const WEATHER_GRID_LNG = 0.022;
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 min

// Bounding box: Uruguay + margen para regiones vecinas (AR/BR fronterizas).
// Usado para validar coords antes de llamar a Google APIs y prevenir abuso.
const inBoundsUY = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -36 && lat <= -29 && lng >= -59 && lng <= -52;

const MAX_BODY_BYTES = 1_000_000; // 1 MB
const MAX_PLACES_QUERY_LEN = 200;

// ─────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────

const CLIENT_ID     = "62eb13eb";
const TOKEN_URL     = "https://mvdapi-auth.montevideo.gub.uy/auth/realms/pci/protocol/openid-connect/token";
const BASE          = "https://api.montevideo.gub.uy/api/transportepublico";

// stm-online: fallback cuando la API pública cae (no requiere auth)
const STM_ONLINE_URL = "https://www.montevideo.gub.uy/buses/rest/stm-online";
const EMPRESA_NAMES = {
  50: "CUTCSA", 70: "UCOT", 10: "COETC", 20: "COME",
  18: "COPSA", 35: "CITA", 33: "CASANOVA", 29: "COIT",
  32: "SAN ANTONIO", 39: "ZEBALLOS HERMANOS", 41: "RUTAS DEL NORTE",
};

const BUSES_CACHE_TTL   = 10_000;   // 10s — dato fresco pero compartido entre requests
const UPCOMING_CACHE_TTL = 10_000;  // 10s por parada
const STOPS_CACHE_TTL   = 86_400_000; // 24h
const RATE_LIMIT_WINDOW = 60_000;   // 1 minuto
const RATE_LIMIT_MAX    = 120;      // max requests por IP por ventana

// Circuit breaker
const CB_THRESHOLD      = 5;        // fallos consecutivos para abrir
const CB_RESET_TIMEOUT  = 30_000;   // 30s antes de probar de nuevo

// Retry
const RETRY_ATTEMPTS    = 3;
const RETRY_BASE_MS     = 500;      // 500ms, 1s, 2s

// ─────────────────────────────────────────────────────────────────
// GTFS estático (cargado una vez por instancia al cold start)
// ─────────────────────────────────────────────────────────────────

const stopLines     = JSON.parse(fs.readFileSync(path.join(__dirname, "stop-lines.json"), "utf8"));
const stopSchedules = JSON.parse(fs.readFileSync(path.join(__dirname, "stop-schedules.json"), "utf8"));
logger.info(`GTFS loaded: ${Object.keys(stopLines).length} stops, ${Object.keys(stopSchedules).length} with schedules`);

// ─────────────────────────────────────────────────────────────────
// Token cache (compartido dentro de la instancia)
// ─────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null; // dedupe: solo un fetch de token a la vez

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  // Si ya hay un fetch en vuelo, esperarlo en vez de hacer otro
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const res = await axios.post(TOKEN_URL,
        new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: immClientSecret.value() }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
      );
      cachedToken = res.data.access_token;
      tokenExpiry = Date.now() + 270_000;
      logger.info("Token renewed");
      return cachedToken;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

// ─────────────────────────────────────────────────────────────────
// Cache genérica con dedupe de requests in-flight
// L1 (memoria por instancia) + L2 (Redis compartido si está disponible)
// ─────────────────────────────────────────────────────────────────

const redisCache = require("./lib/redis-cache");

class RequestCache {
  constructor(ttl, name = "default") {
    this.ttl = ttl;
    this.name = name;             // namespace para L2 (Redis)
    this.entries = new Map();     // L1: key → { data, etag, expiry }
    this.inflight = new Map();    // key → Promise
  }

  // Lectura sincrónica L1
  get(key) {
    const entry = this.entries.get(key);
    if (entry && Date.now() < entry.expiry) return entry;
    return null;
  }

  // Escritura L1 + L2 (L2 fire-and-forget, no bloquea)
  set(key, data) {
    const json = JSON.stringify(data);
    const etag = '"' + crypto.createHash("md5").update(json).digest("hex") + '"';
    const now = Date.now();
    const entry = {
      data, json, etag,
      expiry: now + this.ttl,
      cachedAt: new Date(now).toISOString(),
      ttl: this.ttl,
    };
    this.entries.set(key, entry);
    redisCache.setEntry(this.name, key, entry, this.ttl);
    return entry;
  }

  // Último dato bueno (para circuit breaker fallback)
  getStale(key) {
    return this.entries.get(key) || null;
  }

  // Dedupe: si hay un fetch idéntico en vuelo, esperarlo.
  // Pipeline: L1 → L2 → fetchFn. Si L2 hit, popula L1 y devuelve sin tocar gobierno.
  async dedupe(key, fetchFn) {
    // L1
    const cached = this.get(key);
    if (cached) return cached;

    // Dedupe in-flight
    if (this.inflight.has(key)) {
      await this.inflight.get(key);
      return this.get(key);
    }

    const promise = (async () => {
      try {
        // L2 antes del upstream
        const fromRedis = await redisCache.getEntry(this.name, key);
        if (fromRedis) {
          this.entries.set(key, fromRedis);
          return fromRedis;
        }
        // Upstream
        const data = await fetchFn();
        return this.set(key, data);
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}

const busesCache   = new RequestCache(BUSES_CACHE_TTL);
const upcomingCache = new RequestCache(UPCOMING_CACHE_TTL);
const stopsCache   = new RequestCache(STOPS_CACHE_TTL);
const weatherCache = new RequestCache(WEATHER_CACHE_TTL);
// Forecast cambia más lento que current; cache 30 min para amortiguar costo.
const weatherForecastCache = new RequestCache(30 * 60 * 1000);
// Air Quality cambia lento (1h+); cache 1h. La API factura por call ($1/1000),
// con grid 2km cache 1h: ~720 calls/día = ~$22/mes a escala UY.
const airQualityCache = new RequestCache(60 * 60 * 1000);
// Cache de /vehicles por (cityId+mode+service). TTL corto: dato realtime
// pero compartido entre clientes que hagan polling cerca en tiempo.
const vehiclesCache = new RequestCache(10_000); // 10s
// Caches específicos para feeds dedicados (Subte 10s, Ecobici 30s — la
// info de bicis no cambia tan rápido como buses).
const subteForecastCache = new RequestCache(10_000);
const bikeStationsCache  = new RequestCache(30_000);

// ─────────────────────────────────────────────────────────────────
// Circuit breaker para la API de la IMM
// ─────────────────────────────────────────────────────────────────

const circuitBreaker = {
  failures: 0,
  state: "closed", // closed | open | half-open
  nextRetryAt: 0,

  record(success) {
    if (success) {
      if (this.state !== "closed") {
        logger.info("Circuit breaker: closed (recovered)");
      }
      this.failures = 0;
      this.state = "closed";
    } else {
      this.failures++;
      if (this.failures >= CB_THRESHOLD) {
        this.state = "open";
        this.nextRetryAt = Date.now() + CB_RESET_TIMEOUT;
        logger.warn(`Circuit breaker: OPEN after ${this.failures} failures, retry at +${CB_RESET_TIMEOUT / 1000}s`);
      }
    }
  },

  canRequest() {
    if (this.state === "closed") return true;
    if (this.state === "open" && Date.now() >= this.nextRetryAt) {
      this.state = "half-open";
      logger.info("Circuit breaker: half-open, testing one request");
      return true;
    }
    return this.state === "half-open";
  }
};

// ─────────────────────────────────────────────────────────────────
// Retry con backoff exponencial
// ─────────────────────────────────────────────────────────────────

async function withRetry(fn, label) {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      circuitBreaker.record(true);
      return result;
    } catch (err) {
      const isLast = attempt === RETRY_ATTEMPTS - 1;
      if (isLast) {
        circuitBreaker.record(false);
        throw err;
      }
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(`${label}: attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Fallback: stm-online cuando la API pública cae
// ─────────────────────────────────────────────────────────────────

async function fetchBusesFromStmOnline() {
  const r = await axios.post(STM_ONLINE_URL,
    { subsistema: "-1", empresa: "-1" },
    { headers: { "Content-Type": "application/json" }, timeout: 10_000 }
  );
  const features = r.data?.features || [];
  return features
    .filter(f => {
      // Filtrar coordenadas inválidas
      const coords = f.geometry?.coordinates || [0, 0];
      return coords[0] !== 0 && coords[1] !== 0
        && Math.abs(coords[0]) < 180 && Math.abs(coords[1]) < 90;
    })
    .map(f => {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates || [0, 0];
      const empCode = p.codigoEmpresa || 0;
      return {
        busId: p.codigoBus || 0,
        line: (p.linea || "").trim(),
        company: EMPRESA_NAMES[empCode] || `Empresa ${empCode}`,
        destination: p.destinoDesc || null,
        origin: null,
        subline: p.sublinea || null,
        special: false,
        speed: Math.min(p.velocidad || 0, 100),
        lineVariantId: p.variante || 0,
        access: null,
        thermalConfort: null,
        emissions: null,
        location: { type: "Point", coordinates: coords },
      };
    });
}

// ─────────────────────────────────────────────────────────────────
// Rate limiting por IP (en memoria por instancia)
// ─────────────────────────────────────────────────────────────────

const rateLimitMap = new Map(); // ip → { count, resetAt }

/**
 * Devuelve un objeto con getters de los access tokens MP por país.
 * Cada `defineSecret(...)` se accede con `.value()` solo dentro del runtime
 * del request — esta función centraliza el wrapper para `mp.getClient(country, secrets)`.
 */
function getMpSecrets() {
  return {
    MP_ACCESS_TOKEN_UY: () => { try { return mpAccessTokenUY.value(); } catch { return null; } },
    MP_ACCESS_TOKEN_AR: () => { try { return mpAccessTokenAR.value(); } catch { return null; } },
    MP_ACCESS_TOKEN_BR: () => { try { return mpAccessTokenBR.value(); } catch { return null; } },
  };
}

/**
 * Distancia haversine entre dos coords {lat, lng} en metros.
 * Usado en estimación de tarifa para ride-hailing y distancia entre stops.
 */
function haversineMeters(a, b) {
  const R = 6371000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    return false;
  }
  return true;
}

// Limpiar entradas expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

// ─────────────────────────────────────────────────────────────────
// Helper: enviar datos desde cache envueltos en formato {ok, data, meta}
// ─────────────────────────────────────────────────────────────────
//
// El ETag se calcula sobre `data` raw (no sobre el wrapper), lo que permite
// 304 Not Modified cuando el dato no cambió aunque varíen cachedAt/ttl.
// El cliente (iOS/Android/Dashboard) lee meta.stale en lugar del header
// legacy X-Vamo-Stale (eliminado).

function sendCachedWrapped(req, res, cacheEntry, meta = {}) {
  if (!cacheEntry) return fail(res, "SERVICE_DEGRADED", "Sin datos disponibles");

  const clientEtag = req.headers["if-none-match"];
  if (clientEtag && clientEtag === cacheEntry.etag) {
    return res.status(304).end();
  }

  res.set("ETag", cacheEntry.etag);
  res.set("Cache-Control", "public, max-age=10");

  const ttlRemaining = Math.max(0, Math.floor((cacheEntry.expiry - Date.now()) / 1000));
  const body = {
    ok: true,
    data: cacheEntry.data,
    meta: {
      source: meta.source || "imm",
      stale: meta.stale === true,
      cachedAt: cacheEntry.cachedAt || new Date().toISOString(),
      ttl: ttlRemaining,
      count: Array.isArray(cacheEntry.data) ? cacheEntry.data.length : undefined,
      version: "1",
    },
  };
  if (body.meta.count === undefined) delete body.meta.count;

  const bodyJson = JSON.stringify(body);
  const acceptEncoding = req.headers["accept-encoding"] || "";
  if (acceptEncoding.includes("gzip") && bodyJson.length > 1024) {
    res.set("Content-Encoding", "gzip");
    res.set("Content-Type", "application/json");
    return zlib.gzip(Buffer.from(bodyJson), (err, compressed) => {
      if (err) return res.json(body);
      res.end(compressed);
    });
  }
  return res.json(body);
}

// ─────────────────────────────────────────────────────────────────
// Transformar Google Directions API → formato Vamo
// ─────────────────────────────────────────────────────────────────

function formatTime(epoch) {
  if (!epoch) return "";
  // Google Directions devuelve epoch UTC — convertir a hora Uruguay
  const d = new Date(epoch * 1000);
  const uy = new Date(d.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
  return `${uy.getHours()}:${String(uy.getMinutes()).padStart(2, "0")}`;
}

function transformDirections(googleData) {
  if (!googleData || !googleData.routes) return { routes: [], status: googleData?.status || "UNKNOWN" };

  const routes = googleData.routes.map(route => {
    const leg = route.legs?.[0];
    if (!leg) return null;

    const steps = [];
    for (const step of leg.steps || []) {
      if (step.travel_mode === "WALKING") {
        steps.push({
          type: "walk",
          instruction: step.html_instructions?.replace(/<[^>]*>/g, "") || "Caminar",
          durationMin: Math.round((step.duration?.value || 0) / 60),
          distanceM: step.distance?.value || 0,
          polyline: step.polyline?.points || "",
        });
      } else if (step.travel_mode === "TRANSIT") {
        const transit = step.transit_details;
        const vehicle = transit?.line?.vehicle?.type || "";
        const isBus = vehicle === "BUS" || vehicle === "TROLLEYBUS";
        steps.push({
          type: isBus ? "bus" : "bus", // TODO: support subway/train when Montevideo gets them
          instruction: step.html_instructions?.replace(/<[^>]*>/g, "") || "",
          durationMin: Math.round((step.duration?.value || 0) / 60),
          distanceM: step.distance?.value || 0,
          polyline: step.polyline?.points || "",
          line: transit?.line?.short_name || transit?.line?.name || "",
          lineFullName: transit?.line?.name || "",
          company: (transit?.line?.agencies?.[0]?.name || "").replace(/,.*/, ""),
          headsign: transit?.headsign || "",
          departureStop: transit?.departure_stop?.name || "",
          arrivalStop: transit?.arrival_stop?.name || "",
          departureTime: formatTime(transit?.departure_time?.value),
          arrivalTime: formatTime(transit?.arrival_time?.value),
          numStops: transit?.num_stops || 0,
        });
      }
    }

    return {
      summary: route.summary || "",
      totalDurationMin: Math.round((leg.duration?.value || 0) / 60),
      totalDistanceM: leg.distance?.value || 0,
      departureTime: formatTime(leg.departure_time?.value),
      arrivalTime: formatTime(leg.arrival_time?.value),
      startAddress: leg.start_address || "",
      endAddress: leg.end_address || "",
      polyline: route.overview_polyline?.points || "",
      steps,
    };
  }).filter(Boolean);

  return { routes, status: googleData.status || "OK" };
}

// ─────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────

// Caché de Directions — rutas son determinísticas (mismo origen/destino = misma ruta)
// TTL 24h ahorra miles de dólares/mes a escala
const directionsCache = new RequestCache(86_400_000); // 24h

// Background warming del cache de buses.
// Con minInstances=1 la Cloud Function queda warm permanentemente; aprovechamos
// eso para correr un setInterval que refresca cache cada 7s contra IMM. Los
// requests de usuarios siempre leen cache fresco (<500ms) en vez de esperar
// la IMM (1.5-5s). Ver project_vamo_redesign_master_plan.md → 7a.
let warmerStarted = false;
function startBackgroundWarmer() {
  if (warmerStarted) return;
  warmerStarted = true;
  logger.info("Background bus warmer starting — refresh cada 7s");

  const refresh = async () => {
    if (!circuitBreaker.canRequest()) return;
    try {
      const token = await getToken();
      const r = await withRetry(() =>
        axios.get(`${BASE}/buses`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10_000,
        }),
        "warmer/buses"
      );
      const { valid, rejected } = validateList(schemas.BusSchema, r.data, "warmer/buses");
      if (rejected > 0) logger.info(`Warmer: ${rejected} buses rechazados`);
      busesCache.set("all", valid);
    } catch (e) {
      logger.warn(`Warmer: fallo al refrescar — ${e.message}`);
      // Fallback a stm-online si IMM cae
      try {
        const stmBuses = await fetchBusesFromStmOnline();
        const { valid } = validateList(schemas.BusSchema, stmBuses, "warmer/stm-online");
        if (valid.length > 0) busesCache.set("all", valid);
      } catch (e2) {
        logger.warn(`Warmer fallback tambien falló: ${e2.message}`);
      }
    }
  };

  // Primera corrida inmediata, luego cada 7s
  refresh();
  setInterval(refresh, 7_000);
}

exports.api = onRequest({
  cors: true,
  memory: "2GiB",
  timeoutSeconds: 60,
  minInstances: 1,               // mantener instancia warm 24/7 para el warmer
  concurrency: 500,              // cada instancia atiende hasta 500 requests concurrentes (IO-bound, no CPU)
  vpcConnector: "vamo-connector-saeast",             // acceso a Memorystore Redis en VPC sa-east1
  vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY", // solo tráfico interno (Redis), internet sigue por gateway
  secrets: [
    googleMapsKey, immClientSecret,
    baTransportClientId, baTransportClientSecret,
    mpAccessTokenUY, mpAccessTokenAR, mpAccessTokenBR, mpWebhookSecret,
  ],
}, async (req, res) => {
  // Arrancar warmer en la primera invocación de esta instancia
  startBackgroundWarmer();

  const url = req.path;
  const clientIp = req.headers["x-forwarded-for"] || req.ip || "unknown";

  // ── Rate limit ──
  if (!checkRateLimit(clientIp)) {
    logger.warn(`Rate limited: ${clientIp}`);
    return fail(res, "RATE_LIMITED");
  }

  // ── Body size limit (P1 audit) ──
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return fail(res, "INVALID_REQUEST", "Body excede tamaño máximo");
  }

  // ── Shadow auth: pobla req.auth y req.appCheck si vienen tokens válidos.
  // No rechaza requests sin tokens — los endpoints sensibles validan abajo.
  await extractAuth(req);

  // ── GET /buses ── (migrado al box sanitizador)
  //
  // Pipeline: fuente raw (IMM o stm-online) → validateList(BusSchema) → ok(data, meta).
  // meta.source indica la fuente efectiva, meta.stale indica si venimos de cache stale.
  if (url === "/buses" && req.method === "GET") {
    // 1. Primary: IMM API (si circuit breaker lo permite)
    if (circuitBreaker.canRequest()) {
      try {
        const entry = await busesCache.dedupe("all", async () => {
          const token = await getToken();
          const r = await withRetry(() =>
            axios.get(`${BASE}/buses`, {
              headers: { Authorization: `Bearer ${token}` },
              timeout: 10_000
            }),
            "/buses"
          );
          // Sanitizar con Zod antes de cachear — filtra buses rotos
          const { valid, rejected } = validateList(schemas.BusSchema, r.data, "/buses:imm");
          if (rejected > 0) logger.info(`/buses: ${rejected} buses rechazados por schema`);
          return valid;
        });
        return sendCachedWrapped(req, res, entry, { source: "imm" });
      } catch (e) {
        logger.error(`/buses primary error: ${e.message}`);
        // fall through a fallbacks
      }
    }

    // 2. Fallback: stm-online (datos frescos sin auth)
    try {
      logger.info("Falling back to stm-online for /buses");
      const stmBuses = await fetchBusesFromStmOnline();
      const { valid, rejected } = validateList(schemas.BusSchema, stmBuses, "/buses:stm-online");
      if (rejected > 0) logger.info(`/buses: ${rejected} buses stm-online rechazados`);
      if (valid.length > 0) {
        const entry = busesCache.set("all", valid);
        return sendCachedWrapped(req, res, entry, { source: "stm-online" });
      }
    } catch (e2) {
      logger.error(`/buses stm-online fallback error: ${e2.message}`);
    }

    // 3. Último recurso: stale data del cache
    const stale = busesCache.getStale("all");
    if (stale) {
      logger.info("Serving stale /buses (primary y fallback cayeron)");
      return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
    }

    return fail(res, "IMM_UNAVAILABLE", "Todas las fuentes de buses no disponibles");
  }

  // ── GET /jurisdictions ── (Fase 2 — modelo nuevo)
  // Lista todas las jurisdicciones administrativas catalogadas. Útil para
  // onboarding "¿Dónde vivís?" y picker.
  if (url === "/jurisdictions" && req.method === "GET") {
    return ok(res, { jurisdictions: jurisdictionRegistry.JURISDICTIONS }, {
      source: "registry",
      count:  jurisdictionRegistry.JURISDICTIONS.length,
    });
  }

  // ── GET /jurisdictions/:id ──
  // Devuelve la jurisdicción + sus metroAreas + nationalNetworks + operators
  // que la cubren + modos derivados. Esta es LA query principal del cliente
  // cuando el user activa una jurisdicción.
  if (url.startsWith("/jurisdictions/") && req.method === "GET") {
    const id = url.slice("/jurisdictions/".length);
    if (!id) return fail(res, "INVALID_REQUEST", "Falta jurisdictionId en path");
    const ctx = transportGraph.resolveJurisdiction(id);
    if (!ctx) return fail(res, "INVALID_REQUEST", `Jurisdicción desconocida: ${id}`);
    return ok(res, ctx, { source: "registry" });
  }

  // ── GET /metro-areas ──
  if (url === "/metro-areas" && req.method === "GET") {
    return ok(res, { metroAreas: metroAreaRegistry.METRO_AREAS }, {
      source: "registry",
      count:  metroAreaRegistry.METRO_AREAS.length,
    });
  }

  // ── GET /metro-areas/:id ──
  // Devuelve el metroArea + sus jurisdicciones miembros + operators que lo
  // cubren (directos o vía juri) + modos agregados.
  if (url.startsWith("/metro-areas/") && req.method === "GET") {
    const id = url.slice("/metro-areas/".length);
    if (!id) return fail(res, "INVALID_REQUEST", "Falta metroAreaId en path");
    const ctx = transportGraph.resolveMetroArea(id);
    if (!ctx) return fail(res, "INVALID_REQUEST", `MetroArea desconocido: ${id}`);
    return ok(res, ctx, { source: "registry" });
  }

  // ── GET /national-networks ──
  if (url === "/national-networks" && req.method === "GET") {
    return ok(res, { networks: nationalNetworkRegistry.NATIONAL_NETWORKS }, {
      source: "registry",
      count:  nationalNetworkRegistry.NATIONAL_NETWORKS.length,
    });
  }

  // ── GET /national-networks/:id ──
  if (url.startsWith("/national-networks/") && req.method === "GET") {
    const id = url.slice("/national-networks/".length);
    if (!id) return fail(res, "INVALID_REQUEST", "Falta networkId en path");
    const network = nationalNetworkRegistry.getNationalNetwork(id);
    if (!network) return fail(res, "INVALID_REQUEST", `Network desconocida: ${id}`);
    // Operators que cubren la network
    const operators = operatorRegistry.OPERATORS.filter((op) =>
      op.coverage.nationalNetworks?.includes(id)
    );
    return ok(res, { network, operators }, { source: "registry" });
  }

  // ── GET /operators ──
  if (url === "/operators" && req.method === "GET") {
    return ok(res, { operators: operatorRegistry.OPERATORS }, {
      source: "registry",
      count:  operatorRegistry.OPERATORS.length,
    });
  }

  // ── GET /operators/:id ──
  if (url.startsWith("/operators/") && req.method === "GET") {
    const id = url.slice("/operators/".length);
    if (!id) return fail(res, "INVALID_REQUEST", "Falta operatorId en path");
    const operator = operatorRegistry.OPERATORS_BY_ID[id];
    if (!operator) return fail(res, "INVALID_REQUEST", `Operator desconocido: ${id}`);
    return ok(res, { operator }, { source: "registry" });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Wallet + Payments — Mercado Pago multi-país (UY/AR/BR) ─── 2026-04-27
  //
  // Wallet del user vive en Firestore como `wallets/{userId}_{country}`.
  // Cards se guardan en MP Customer API + referencia en Firestore (id, last4,
  // brand, alias). NO guardamos PAN ni CVV nunca (PCI: tarjeta solo en cliente
  // → tokenizada → token al server → server crea payment con token).
  //
  // Sin saldo propio en v1.0 (solo "tarjetas guardadas" + historial). Saldo
  // requeriría licencia BCU EMP en UY — post-launch.
  // ─────────────────────────────────────────────────────────────────────────

  // GET /wallet/me?country=UY — wallet del user para un país.
  // Crea Customer MP en background si no existía + persiste mpCustomerId.
  if (url === "/wallet/me" && req.method === "GET") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const country = (req.query.country || "UY").toString().toUpperCase();
    if (!mp.SUPPORTED_COUNTRIES.includes(country)) {
      return fail(res, "INVALID_REQUEST", `Mercado Pago no soportado en ${country}`);
    }
    try {
      const db = admin.firestore();
      const walletId = `${req.auth.uid}_${country}`;
      const docRef = db.collection("wallets").doc(walletId);
      let snapshot = await docRef.get();
      let wallet;
      const client = mp.getClient(country, getMpSecrets());

      if (!snapshot.exists) {
        // Crear customer MP + wallet
        const userEmail = req.auth.token?.email || `vamo-${req.auth.uid}@vamo.com.uy`;
        const customer = await mp.createCustomer(client, { email: userEmail });
        wallet = {
          userId:        req.auth.uid,
          country,
          mpCustomerId:  customer.id,
          cards:         [],
          createdAt:     new Date().toISOString(),
          mock:          client.mock,
        };
        await docRef.set(wallet);
      } else {
        wallet = snapshot.data();
        // Refrescar tarjetas desde MP si hay customerId real
        if (!client.mock && wallet.mpCustomerId && !wallet.mpCustomerId.startsWith("mock_")) {
          const cards = await mp.listCustomerCards(client, wallet.mpCustomerId);
          wallet.cards = cards.map((c) => ({
            id:           c.id,
            last4:        c.last_four_digits,
            brand:        c.payment_method?.id || c.payment_method?.name || "unknown",
            expMonth:     c.expiration_month,
            expYear:      c.expiration_year,
            cardholderName: c.cardholder?.name || null,
          }));
          await docRef.update({ cards: wallet.cards });
        }
      }
      return ok(res, wallet, { source: "mercadopago", mock: client.mock });
    } catch (e) {
      logger.error(`/wallet/me error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR", "No se pudo obtener la billetera");
    }
  }

  // POST /wallet/cards?country=UY — agregar tarjeta tokenizada
  // Body: { cardToken: "..." }  (tokenizado en cliente con MP_PUBLIC_KEY)
  if (url === "/wallet/cards" && req.method === "POST") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const country = (req.query.country || "UY").toString().toUpperCase();
    const cardToken = (req.body?.cardToken || "").toString();
    if (!cardToken) return fail(res, "INVALID_REQUEST", "Falta cardToken");
    try {
      const db = admin.firestore();
      const walletId = `${req.auth.uid}_${country}`;
      const docRef = db.collection("wallets").doc(walletId);
      const doc = await docRef.get();
      if (!doc.exists) {
        return fail(res, "INVALID_REQUEST", "Wallet no existe — llamar /wallet/me primero");
      }
      const wallet = doc.data();
      const client = mp.getClient(country, getMpSecrets());
      const card = await mp.saveCardToCustomer(client, {
        customerId: wallet.mpCustomerId,
        cardToken,
      });
      const newCard = {
        id:    card.id,
        last4: card.last_four_digits || "0006",
        brand: card.payment_method?.id || card.payment_method?.name || "unknown",
        expMonth: card.expiration_month || null,
        expYear:  card.expiration_year || null,
        cardholderName: card.cardholder?.name || null,
      };
      await docRef.update({
        cards: admin.firestore.FieldValue.arrayUnion(newCard),
      });
      return ok(res, { card: newCard }, { source: "mercadopago", mock: client.mock });
    } catch (e) {
      logger.error(`/wallet/cards POST error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR", "No se pudo guardar la tarjeta");
    }
  }

  // DELETE /wallet/cards/:cardId?country=UY — eliminar tarjeta
  if (url.startsWith("/wallet/cards/") && req.method === "DELETE") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const cardId = url.slice("/wallet/cards/".length);
    const country = (req.query.country || "UY").toString().toUpperCase();
    try {
      const db = admin.firestore();
      const walletId = `${req.auth.uid}_${country}`;
      const docRef = db.collection("wallets").doc(walletId);
      const doc = await docRef.get();
      if (!doc.exists) return fail(res, "NOT_FOUND");
      const wallet = doc.data();
      const client = mp.getClient(country, getMpSecrets());
      await mp.deleteCustomerCard(client, { customerId: wallet.mpCustomerId, cardId });
      const remaining = (wallet.cards || []).filter((c) => c.id !== cardId);
      await docRef.update({ cards: remaining });
      return ok(res, { deleted: true, cardId }, { source: "mercadopago", mock: client.mock });
    } catch (e) {
      logger.error(`/wallet/cards DELETE error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR", "No se pudo eliminar la tarjeta");
    }
  }

  // POST /payments/charge — charge directo con card_token (transparent flow)
  // Body: { cardToken, amount, currency?, description, externalReference, country, paymentMethodId, installments? }
  if (url === "/payments/charge" && req.method === "POST") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const body = req.body || {};
    const country = (body.country || "UY").toString().toUpperCase();
    if (!body.cardToken)        return fail(res, "INVALID_REQUEST", "Falta cardToken");
    if (!body.amount || body.amount <= 0) return fail(res, "INVALID_REQUEST", "Amount inválido");
    if (!body.paymentMethodId)  return fail(res, "INVALID_REQUEST", "Falta paymentMethodId");
    try {
      const client = mp.getClient(country, getMpSecrets());
      const userEmail = req.auth.token?.email || `vamo-${req.auth.uid}@vamo.com.uy`;
      const payment = await mp.createPayment(client, {
        amount:            body.amount,
        token:             body.cardToken,
        description:       body.description || "Pago Vamo",
        installments:      body.installments || 1,
        paymentMethodId:   body.paymentMethodId,
        payerEmail:        userEmail,
        externalReference: body.externalReference || null,
        idempotencyKey:    body.idempotencyKey || `${req.auth.uid}-${Date.now()}`,
      });

      // Persistir payment para auditoría + historial de wallet
      const db = admin.firestore();
      await db.collection("payments").doc(String(payment.id)).set({
        id:           String(payment.id),
        userId:       req.auth.uid,
        country,
        amount:       payment.transaction_amount,
        currency:     payment.currency_id,
        status:       payment.status,
        statusDetail: payment.status_detail,
        description:  payment.description,
        rideRequestId: body.externalReference || null,
        mock:         payment._mock === true,
        createdAt:    new Date().toISOString(),
      });

      logger.info(`/payments/charge ${payment.id} status=${payment.status} mock=${client.mock} user=${req.auth.uid}`);
      return ok(res, payment, { source: "mercadopago", mock: client.mock });
    } catch (e) {
      const mpError = e.response?.data || e.message;
      logger.error(`/payments/charge error: ${typeof mpError === "object" ? JSON.stringify(mpError) : mpError}`);
      return fail(res, "INTERNAL_ERROR", "Pago rechazado o error en Mercado Pago");
    }
  }

  // POST /payments/webhook — IPN de Mercado Pago
  // MP envía notificaciones cuando el estado de un pago cambia (pending→approved
  // por ejemplo). Verificamos firma + actualizamos Firestore.
  if (url === "/payments/webhook" && req.method === "POST") {
    const xSignature = req.headers["x-signature"];
    const xRequestId = req.headers["x-request-id"];
    const dataId = req.body?.data?.id || req.query?.["data.id"];
    let secret = null;
    try { secret = mpWebhookSecret.value(); } catch { secret = null; }

    const valid = mp.verifyWebhookSignature({ secret, xSignature, xRequestId, dataId });
    if (!valid) {
      logger.warn(`/payments/webhook firma inválida data.id=${dataId}`);
      return fail(res, "FORBIDDEN", "Firma inválida");
    }

    const action = req.body?.action || req.body?.type || "unknown";
    logger.info(`/payments/webhook action=${action} data.id=${dataId}`);

    // Etapa 2: cuando llegue notification "payment.updated", fetcheamos el
    // payment de MP y actualizamos `payments/{id}` + `rideRequests/{id}`.
    // Por ahora acknowledge para que MP no reintente.
    return ok(res, { received: true, action, dataId }, { source: "mercadopago" });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ── Modo Taxi/Remis — Vamo marketplace propio ─── (Etapa 1 — 2026-04-27)
  //
  // Stubs sin lógica de matching. Persisten en Firestore con status="searching"
  // y devuelven el requestId. Etapa 2 (post-launch) sumará matching real,
  // driver app, GPS streaming y notifications.
  //
  // Auth: requiere Firebase Auth ID token (req.auth.uid es el passenger).
  // ─────────────────────────────────────────────────────────────────────────

  // POST /rides — crear ride request
  if (url === "/rides" && req.method === "POST") {
    if (!req.auth?.uid) {
      return fail(res, "UNAUTHORIZED", "Login requerido para pedir un viaje");
    }
    const parsed = rideSchemas.CreateRideInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, "INVALID_REQUEST", parsed.error.message.slice(0, 200));
    }

    // Validar que origen y destino estén en jurisdicciones soportadas
    const originJuri = jurisdictionRegistry.getJurisdiction(parsed.data.origin.jurisdictionId);
    if (!originJuri) {
      return fail(res, "INVALID_REQUEST", `Jurisdicción origen desconocida: ${parsed.data.origin.jurisdictionId}`);
    }
    const destJuri = jurisdictionRegistry.getJurisdiction(parsed.data.destination.jurisdictionId);
    if (!destJuri) {
      return fail(res, "INVALID_REQUEST", `Jurisdicción destino desconocida: ${parsed.data.destination.jurisdictionId}`);
    }

    try {
      const db = admin.firestore();
      const docRef = db.collection("rideRequests").doc();
      const now = new Date().toISOString();
      const requestId = docRef.id;

      // Etapa 1: fareEstimate stub (tarifa fija configurable post-launch)
      // Estimación grosera: $50 base + $30/km. Real = pricing engine post-launch.
      const distMeters = haversineMeters(parsed.data.origin.coord, parsed.data.destination.coord);
      const distKm = distMeters / 1000;
      const baseEstimateCents = 5000 + Math.round(distKm * 3000);  // UYU centavos
      const minCents = Math.round(baseEstimateCents * 0.85);
      const maxCents = Math.round(baseEstimateCents * 1.20);

      const rideDoc = {
        id:               requestId,
        passengerId:      req.auth.uid,
        origin:           parsed.data.origin,
        destination:      parsed.data.destination,
        serviceKind:      parsed.data.serviceKind,
        requestedAt:      now,
        status:           "searching",
        matchedDriverId:  null,
        matchedVehicleId: null,
        fareEstimate:     { min: minCents, max: maxCents, currency: "UYU" },
        fareFinal:        null,
        paymentMethod:    parsed.data.paymentMethod,
        paymentCardId:    parsed.data.paymentCardId || null,
        paymentStatus:    "pending",
        paymentId:        null,
        timeline:         [{ event: "created", at: now, by: req.auth.uid }],
      };

      await docRef.set(rideDoc);
      logger.info(`/rides POST: ${requestId} passenger=${req.auth.uid} ${parsed.data.serviceKind} ${originJuri.id}→${destJuri.id} estimate=${minCents}-${maxCents} UYU`);

      // Etapa 1: NO arranca matching. Sistema queda en "searching" indefinido.
      // Cliente debe llamar /rides/:id/cancel si user aborta.
      return ok(res, rideDoc, { source: "ride-hailing", phase: "etapa-1-stub" });
    } catch (e) {
      logger.error(`/rides POST error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR", "No se pudo crear el viaje");
    }
  }

  // GET /rides/me/active — ride activo del passenger (si hay)
  if (url === "/rides/me/active" && req.method === "GET") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    try {
      const db = admin.firestore();
      const snap = await db.collection("rideRequests")
        .where("passengerId", "==", req.auth.uid)
        .where("status", "in", ["searching", "matched", "driver_accepted", "driver_arrived", "in_progress"])
        .limit(1)
        .get();
      if (snap.empty) return ok(res, { active: null }, { source: "ride-hailing" });
      return ok(res, { active: snap.docs[0].data() }, { source: "ride-hailing" });
    } catch (e) {
      logger.error(`/rides/me/active error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // GET /rides/:id — leer ride (passenger solo el suyo)
  if (url.startsWith("/rides/") && req.method === "GET" && !url.endsWith("/cancel") && !url.endsWith("/rate") && url !== "/rides/me/active" && url !== "/rides/me/history") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const id = url.slice("/rides/".length);
    if (!id || id.includes("/")) return fail(res, "INVALID_REQUEST", "Falta rideId");
    try {
      const db = admin.firestore();
      const doc = await db.collection("rideRequests").doc(id).get();
      if (!doc.exists) return fail(res, "NOT_FOUND", "Ride no existe");
      const data = doc.data();
      if (data.passengerId !== req.auth.uid) {
        // Driver matched también puede leer (etapa 2). Por ahora, solo passenger.
        return fail(res, "FORBIDDEN", "Este viaje no es tuyo");
      }
      return ok(res, data, { source: "ride-hailing" });
    } catch (e) {
      logger.error(`/rides/:id GET error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // POST /rides/:id/cancel — passenger cancela
  if (url.endsWith("/cancel") && url.startsWith("/rides/") && req.method === "POST") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const id = url.slice("/rides/".length, -"/cancel".length);
    const parsed = rideSchemas.CancelRideInputSchema.safeParse(req.body || {});
    const reason = parsed.success ? parsed.data.reason : null;
    try {
      const db = admin.firestore();
      const docRef = db.collection("rideRequests").doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return fail(res, "NOT_FOUND");
      const data = doc.data();
      if (data.passengerId !== req.auth.uid) return fail(res, "FORBIDDEN");
      if (["completed", "cancelled_by_passenger", "cancelled_by_driver", "no_drivers_available"].includes(data.status)) {
        return fail(res, "INVALID_REQUEST", `Ride ya está en estado terminal: ${data.status}`);
      }
      const now = new Date().toISOString();
      await docRef.update({
        status: "cancelled_by_passenger",
        timeline: [...(data.timeline || []), { event: "cancelled_by_passenger", at: now, by: req.auth.uid, meta: reason ? { reason } : null }],
      });
      logger.info(`/rides/${id}/cancel by passenger=${req.auth.uid}`);
      return ok(res, { id, status: "cancelled_by_passenger" }, { source: "ride-hailing" });
    } catch (e) {
      logger.error(`/rides/:id/cancel error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // POST /rides/:id/complete — cierra el ride + dispara charge si aplica.
  //
  // Etapa 1 (testing): cualquier passenger puede completar SUS PROPIOS rides
  // para validar el flow end-to-end sin matching real.
  // Etapa 2 (prod): solo el driver matched podrá hacer esto via app driver.
  //
  // Charge:
  //   - paymentMethod=cash → no se cobra. paymentStatus queda "pending"
  //     (pasajero paga al driver cash al bajar).
  //   - paymentMethod=mercadopago + paymentCardId="account_money" → charge
  //     con payment_method_id="account_money" (dinero en cuenta MP).
  //   - paymentMethod=mercadopago + paymentCardId=<MP card_id> → charge
  //     con la tarjeta guardada (etapa actual: backend usa el card_id directo
  //     como token; en producción real, cliente regenera card_token con CVV
  //     y lo manda. Mock mode no requiere CVV).
  if (url.endsWith("/complete") && url.startsWith("/rides/") && req.method === "POST") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    const id = url.slice("/rides/".length, -"/complete".length);
    try {
      const db = admin.firestore();
      const docRef = db.collection("rideRequests").doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return fail(res, "NOT_FOUND");
      const data = doc.data();
      if (data.passengerId !== req.auth.uid) return fail(res, "FORBIDDEN");
      if (["completed", "cancelled_by_passenger", "cancelled_by_driver", "no_drivers_available"].includes(data.status)) {
        return fail(res, "INVALID_REQUEST", `Ride ya está en estado terminal: ${data.status}`);
      }

      const now = new Date().toISOString();
      // Fare final = midpoint del estimate (Etapa 1 sin GPS path real).
      // Etapa 2: server calcula con distance/time real del GPS streaming del driver.
      const minF = data.fareEstimate?.min || 0;
      const maxF = data.fareEstimate?.max || 0;
      const fareFinalCents = Math.round((minF + maxF) / 2);
      const currency = data.fareEstimate?.currency || "UYU";

      const updates = {
        status: "completed",
        fareFinal: fareFinalCents,
        timeline: [...(data.timeline || []), { event: "completed", at: now, by: req.auth.uid }],
      };

      // Charge si paymentMethod=mercadopago
      if (data.paymentMethod === "mercadopago") {
        const country = data.origin?.jurisdictionId
          ? data.origin.jurisdictionId.split(".")[0].toUpperCase()
          : "UY";
        if (!mp.SUPPORTED_COUNTRIES.includes(country)) {
          return fail(res, "INVALID_REQUEST", `País ${country} no soportado por Mercado Pago`);
        }
        try {
          const client = mp.getClient(country, getMpSecrets());
          const userEmail = req.auth.token?.email || `vamo-${req.auth.uid}@vamo.com.uy`;

          // amount en MP es decimal (UYU 75.50 = 75.50, no cents)
          const amount = fareFinalCents / 100;

          // payment_method_id: si paymentCardId == "account_money" → account_money,
          // sino derivado del brand de la tarjeta. En modo mock, "visa" es default.
          let paymentMethodId = "visa";
          let cardToken = data.paymentCardId || "mock_card_token";
          if (data.paymentCardId === "account_money") {
            paymentMethodId = "account_money";
            cardToken = "mock_account_money_token";
          } else if (data.paymentCardId && !client.mock) {
            // Producción real: cliente debe regenerar card_token desde cardId+CVV
            // antes del charge. Por ahora asumimos que el cardId es el token
            // directo (válido solo en mock).
            cardToken = data.paymentCardId;
          }

          const payment = await mp.createPayment(client, {
            amount,
            token: cardToken,
            description: `Vamo ${data.serviceKind} ${data.origin?.address || ""} → ${data.destination?.address || ""}`.slice(0, 250),
            installments: 1,
            paymentMethodId,
            payerEmail: userEmail,
            externalReference: id,
            idempotencyKey: `complete-${id}`,
          });

          // Persistir payment doc
          await db.collection("payments").doc(String(payment.id)).set({
            id:           String(payment.id),
            userId:       req.auth.uid,
            country,
            amount:       payment.transaction_amount,
            currency:     payment.currency_id || currency,
            status:       payment.status,
            statusDetail: payment.status_detail,
            description:  payment.description,
            rideRequestId: id,
            mock:         payment._mock === true,
            createdAt:    now,
          });

          updates.paymentId = String(payment.id);
          updates.paymentStatus = payment.status === "approved" ? "paid" : "pending";
          updates.timeline.push({
            event: payment.status === "approved" ? "paid" : "payment_pending",
            at: now,
            by: req.auth.uid,
            meta: { paymentId: String(payment.id), mock: payment._mock === true },
          });
          logger.info(`/rides/${id}/complete charge ${payment.id} status=${payment.status} mock=${client.mock}`);
        } catch (e) {
          const mpError = e.response?.data || e.message;
          logger.error(`/rides/${id}/complete charge error: ${typeof mpError === "object" ? JSON.stringify(mpError) : mpError}`);
          updates.paymentStatus = "disputed";
          updates.timeline.push({
            event: "payment_failed",
            at: now,
            by: req.auth.uid,
            meta: { error: typeof mpError === "string" ? mpError : "MP error" },
          });
        }
      }

      await docRef.update(updates);
      return ok(res, { id, ...updates }, { source: "ride-hailing" });
    } catch (e) {
      logger.error(`/rides/:id/complete error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // GET /rides/me/history — viajes pasados del passenger
  if (url === "/rides/me/history" && req.method === "GET") {
    if (!req.auth?.uid) return fail(res, "UNAUTHORIZED");
    try {
      const db = admin.firestore();
      const snap = await db.collection("rideRequests")
        .where("passengerId", "==", req.auth.uid)
        .where("status", "in", ["completed", "cancelled_by_passenger", "cancelled_by_driver", "no_drivers_available"])
        .orderBy("requestedAt", "desc")
        .limit(50)
        .get();
      const items = snap.docs.map((d) => d.data());
      return ok(res, { items, count: items.length }, { source: "ride-hailing" });
    } catch (e) {
      logger.error(`/rides/me/history error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // ── GET /subte-forecast?jurisdictionId=ar.caba ─── (Fase 3 ext — 2026-04-27)
  //
  // Devuelve TripUpdates del Subte de Buenos Aires. Formato custom no-GTFS
  // (arrival predictions por estación, sin GPS de vehículos). Cliente iOS
  // muestra arrivals por estación, no en mapa.
  //
  // Solo disponible para `jurisdictionId=ar.caba` por ahora (Subte solo CABA).
  if (url === "/subte-forecast" && req.method === "GET") {
    const jurisdictionId = (req.query.jurisdictionId || "").toString().toLowerCase();
    if (jurisdictionId !== "ar.caba") {
      return fail(res, "INVALID_REQUEST", "Subte solo disponible para jurisdictionId=ar.caba");
    }
    try {
      const entry = await subteForecastCache.dedupe("default", async () => {
        const r = await gcbaSubte.fetchSubteForecast({
          clientId:     baTransportClientId.value(),
          clientSecret: baTransportClientSecret.value(),
        });
        if (r.rejectedCount > 0) {
          logger.info(`/subte-forecast: ${r.rejectedCount} entries rechazadas por schema`);
        }
        return {
          tripUpdates:    r.tripUpdates,
          jurisdictionId,
          feedTimestamp:  r.feedTimestamp,
        };
      });
      return sendCachedWrapped(req, res, entry, {
        source:   "gcba-subte-forecast",
        dataMode: "official",
      });
    } catch (e) {
      logger.error(`/subte-forecast error: ${e.message}`);
      const stale = subteForecastCache.getStale("default");
      if (stale) {
        return sendCachedWrapped(req, res, stale, {
          source: "gcba-subte-forecast", dataMode: "official", stale: true,
        });
      }
      return fail(res, "FEED_UNAVAILABLE", "Subte forecast no disponible");
    }
  }

  // ── GET /bike-stations?jurisdictionId=ar.caba ─── (Fase 3 ext)
  //
  // Estaciones de Ecobici AMBA (GBFS). Combina stationInformation (estática)
  // + stationStatus (live: bikes/docks disponibles). Solo CABA por ahora.
  if (url === "/bike-stations" && req.method === "GET") {
    const jurisdictionId = (req.query.jurisdictionId || "").toString().toLowerCase();
    if (jurisdictionId !== "ar.caba") {
      return fail(res, "INVALID_REQUEST", "Bike stations solo disponible para jurisdictionId=ar.caba");
    }
    try {
      const entry = await bikeStationsCache.dedupe("default", async () => {
        const r = await gcbaEcobici.fetchEcobiciStations({
          clientId:     baTransportClientId.value(),
          clientSecret: baTransportClientSecret.value(),
        });
        if (r.rejectedCount > 0) {
          logger.info(`/bike-stations: ${r.rejectedCount} estaciones rechazadas por schema`);
        }
        return {
          stations:       r.stations,
          jurisdictionId,
          systemId:       "ecobici-amba",
          feedTimestamp:  r.feedTimestamp,
        };
      });
      return sendCachedWrapped(req, res, entry, {
        source:   "gcba-ecobici-gbfs",
        dataMode: "official",
      });
    } catch (e) {
      logger.error(`/bike-stations error: ${e.message}`);
      const stale = bikeStationsCache.getStale("default");
      if (stale) {
        return sendCachedWrapped(req, res, stale, {
          source: "gcba-ecobici-gbfs", dataMode: "official", stale: true,
        });
      }
      return fail(res, "FEED_UNAVAILABLE", "Ecobici no disponible");
    }
  }

  // ── GET /vehicles?country=X&zone=Y&mode=Z[&service=W] ── (Milestone 1 Foundation)
  // ── GET /vehicles?jurisdictionId=X&mode=Z[&service=W] ─── (Fase 2 — modelo nuevo)
  //
  // Endpoint genérico multi-ciudad / multi-modo. Reemplazo gradual de /buses,
  // /buses queda como alias compatible para no romper la app actual.
  //
  // Modo legacy (compat hasta 2.E):
  //   Resuelve CityConfig + adapter via cityRegistry → ModeConfig.feed
  //
  // Modo nuevo (Fase 2):
  //   Resuelve Jurisdiction → operators que la cubren → feed con (mode, service)
  //   Si hay varios operators con feed RT para el mismo (mode, service), se
  //   prioriza por orden de aparición en operators.js (primary primero).
  if (url === "/vehicles" && req.method === "GET") {
    const jurisdictionId = (req.query.jurisdictionId || "").toString().toLowerCase();
    const networkId      = (req.query.networkId      || "").toString().toLowerCase();
    const country = (req.query.country || "").toString().toLowerCase();
    const zone    = (req.query.zone    || "").toString().toLowerCase();
    const mode    = (req.query.mode    || "").toString().toLowerCase();
    const service = (req.query.service || "").toString().toLowerCase() || null;

    if (!mode) return fail(res, "INVALID_REQUEST", "Falta mode");

    let cityIdForCache;
    let modeConfig;

    // Modo nuevo (national network): resuelve via NationalNetwork → operators
    // que la cubren → primer feed RT. Usado para feeds nacionales como
    // OVapi Holanda, Renfe LD, MTOP UY.
    if (networkId) {
      const network = nationalNetworkRegistry.getNationalNetwork(networkId);
      if (!network) {
        return fail(res, "INVALID_REQUEST", `Network desconocida: ${networkId}`);
      }
      const ops = operatorRegistry.OPERATORS.filter((o) =>
        o.coverage.nationalNetworks?.includes(networkId)
      );
      const feeds = [];
      for (const op of ops) {
        for (const f of op.feeds) {
          if (f.mode !== mode) continue;
          if (service && f.service !== service) continue;
          if (!f.adapterId) continue;
          feeds.push({ operatorId: op.id, ...f });
        }
      }
      if (feeds.length === 0) {
        return ok(res, { vehicles: [], networkId, mode, service }, {
          source: "static", dataMode: "staticOnly", cached: false,
        });
      }
      const feed = feeds[0];
      modeConfig = { dataMode: feed.dataMode, feed: feed.adapterId };
      cityIdForCache = networkId;
    } else if (jurisdictionId) {
      // Modo nuevo: resuelve via Jurisdiction → operators → primer feed RT que matchea
      const feeds = transportGraph.getActiveFeedsForJurisdictionMode(jurisdictionId, mode, service);
      if (feeds.length === 0) {
        // Sin feed RT — devolver lista vacía con dataMode resuelto
        const ctx = transportGraph.resolveJurisdiction(jurisdictionId);
        if (!ctx) {
          return fail(res, "INVALID_REQUEST", `Jurisdicción desconocida: ${jurisdictionId}`);
        }
        // Match: si service explícito, exact match; si no, cualquier entry con
        // ese mode (toma la "mejor" por dataMode rank).
        const candidates = ctx.modes.filter((m) =>
          m.mode === mode && (service ? m.service === service : true)
        );
        const rank = { official: 3, hybrid: 3, staticOnly: 2, communityOnly: 1 };
        candidates.sort((a, b) => (rank[b.dataMode] || 0) - (rank[a.dataMode] || 0));
        const modeEntry = candidates[0];
        const dataMode = modeEntry?.dataMode || "communityOnly";
        return ok(res, { vehicles: [], jurisdictionId, mode, service }, {
          source:   dataMode === "staticOnly" ? "static" : "community",
          dataMode,
          cached:   false,
        });
      }
      // Primer feed RT (priority = orden en operators.js)
      const feed = feeds[0];
      modeConfig = { dataMode: feed.dataMode, feed: feed.adapterId };
      cityIdForCache = jurisdictionId;
    } else {
      // Modo legacy: country + zone (compat hasta 2.E)
      if (!country || !zone) {
        return fail(res, "INVALID_REQUEST", "Falta jurisdictionId, o country+zone");
      }
      const city = cityRegistry.getCity(country, zone);
      if (!city) {
        return fail(res, "INVALID_REQUEST", `Ciudad desconocida: ${country}.${zone}`);
      }
      modeConfig = cityRegistry.getMode(city, mode, service);
      if (!modeConfig) {
        return fail(res, "INVALID_REQUEST", `Modo no soportado en ${city.id}: ${mode}${service ? "." + service : ""}`);
      }
      cityIdForCache = city.id;
    }

    // Si el modo está en .communityOnly (sin feed oficial), devolvemos lista
    // vacía con meta.dataMode — el cliente sabe que tiene que mostrar la UI
    // específica de comunidad. Los reportes comunitarios los lee Firestore
    // directo (no pasa por este endpoint).
    if (modeConfig.dataMode === "communityOnly") {
      return ok(res, { vehicles: [], cityId: cityIdForCache, mode, service }, {
        source:    "community",
        dataMode:  "communityOnly",
        cached:    false,
      });
    }

    // staticOnly sin feed RT: el cliente consume el snapshot GTFS estático
    // de Cloud Storage. Aquí devolvemos lista vacía con meta.dataMode para
    // que la UI muestre paradas/recorridos del catálogo en vez de vehículos.
    if (modeConfig.dataMode === "staticOnly" && !modeConfig.feed) {
      return ok(res, { vehicles: [], cityId: cityIdForCache, mode, service }, {
        source:    "static",
        dataMode:  "staticOnly",
        cached:    false,
      });
    }

    if (!modeConfig.feed) {
      return fail(res, "INVALID_REQUEST", `Sin feed configurado para ${cityIdForCache}.${mode}`);
    }

    const cacheKey = `${cityIdForCache}:${mode}:${service || "default"}`;
    const ctx = {
      cityId:     cityIdForCache,
      mode,
      feedSource: modeConfig.feed,
    };

    try {
      const entry = await vehiclesCache.dedupe(cacheKey, async () => {
        const result = await adapterRegistry.dispatch(modeConfig.feed, ctx, {
          baTransportClientId:     baTransportClientId.value(),
          baTransportClientSecret: baTransportClientSecret.value(),
          // Helpers para imm-stm: comparte el token cache singleton de /buses
          // y la normalización de stm-online (incluye EMPRESA_NAMES mapping).
          getImmToken:             getToken,
          fetchStmOnlineRaw:       fetchBusesFromStmOnline,
        });
        if (result.rejectedCount > 0) {
          logger.info(`/vehicles ${ctx.feedSource}: ${result.rejectedCount} rechazados por schema`);
        }
        return {
          vehicles:      result.vehicles,
          cityId:        cityIdForCache,
          mode,
          service:       service || null,
          feedTimestamp: result.feedTimestamp || null,
        };
      });
      return sendCachedWrapped(req, res, entry, {
        source:   modeConfig.feed,
        dataMode: modeConfig.dataMode,
      });
    } catch (e) {
      logger.error(`/vehicles ${cityIdForCache}.${mode} error: ${e.message}`);
      const stale = vehiclesCache.getStale(cacheKey);
      if (stale) {
        return sendCachedWrapped(req, res, stale, {
          source:   modeConfig.feed,
          dataMode: modeConfig.dataMode,
          stale:    true,
        });
      }
      return fail(res, "FEED_UNAVAILABLE", `Feed ${modeConfig.feed} no disponible`);
    }
  }

  // ── GET /busstops ── (migrado)
  if (url === "/busstops" && req.method === "GET") {
    try {
      const entry = await stopsCache.dedupe("all", async () => {
        const token = await getToken();
        const r = await withRetry(() =>
          axios.get(`${BASE}/buses/busstops`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30_000
          }),
          "/busstops"
        );
        const { valid, rejected } = validateList(schemas.BusStopSchema, r.data, "/busstops");
        if (rejected > 0) logger.info(`/busstops: ${rejected} paradas rechazadas por schema`);
        logger.info(`Bus stops: ${valid.length} válidos`);
        return valid;
      });
      return sendCachedWrapped(req, res, entry, { source: "imm" });
    } catch (e) {
      logger.error(`/busstops error: ${e.message}`);
      const stale = stopsCache.getStale("all");
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "IMM_UNAVAILABLE");
    }
  }

  // ── GET /buses/bylines?lines=109,121,G ── (migrado)
  if (url === "/buses/bylines" && req.method === "GET") {
    const linesParam = req.query.lines;
    if (!linesParam) return fail(res, "INVALID_REQUEST", "Falta parámetro 'lines'");

    const linesList = linesParam.split(",").map(l => l.trim()).filter(Boolean);
    if (linesList.length === 0) return ok(res, [], { source: "computed" });

    const cacheKey = linesList.sort().join(",");

    try {
      // Primero intentar filtrar desde el cache general de /buses si está fresco
      const allBuses = busesCache.get("all");
      if (allBuses && Array.isArray(allBuses.data)) {
        const lineSet = new Set(linesList.map(l => l.trim()));
        const filtered = allBuses.data.filter(b => lineSet.has((b.line || "").trim()));
        logger.info(`/buses/bylines: filtered ${filtered.length}/${allBuses.data.length} desde cache`);
        return ok(res, filtered, {
          source: "cache",
          cachedAt: allBuses.cachedAt,
          ttl: Math.max(0, Math.floor((allBuses.expiry - Date.now()) / 1000)),
        });
      }

      // Sin cache general: pedir a la IMM con filtro de líneas
      const entry = await upcomingCache.dedupe(`bylines:${cacheKey}`, async () => {
        const token = await getToken();
        const r = await withRetry(() =>
          axios.get(`${BASE}/buses`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { lines: linesList },
            timeout: 10_000,
          }),
          `/buses/bylines`
        );
        const { valid } = validateList(schemas.BusSchema, r.data, "/buses/bylines");
        return valid;
      });
      return sendCachedWrapped(req, res, entry, { source: "imm" });
    } catch (e) {
      logger.error(`/buses/bylines error: ${e.message}`);
      // Fallback: filtrar desde cache stale
      const stale = busesCache.getStale("all");
      if (stale) {
        const lineSet = new Set(linesList);
        const filtered = stale.data.filter(b => lineSet.has((b.line || "").trim()));
        return ok(res, filtered, { source: "cache", stale: true, cachedAt: stale.cachedAt });
      }
      return fail(res, "IMM_UNAVAILABLE");
    }
  }

  // ── GET /busstops/:id/lines ── (migrado)
  const linesMatch = url.match(/^\/busstops\/(\d+)\/lines$/);
  if (linesMatch && req.method === "GET") {
    const lines = stopLines[linesMatch[1]] || [];
    return ok(res, lines, { source: "gtfs" });
  }

  // ── GET /busstops/:id/upcoming ── (migrado)
  const upcomingMatch = url.match(/^\/busstops\/(\d+)\/upcoming$/);
  if (upcomingMatch && req.method === "GET") {
    const id = upcomingMatch[1];
    const lines = stopLines[id] || [];
    if (lines.length === 0) return ok(res, [], { source: "gtfs" });

    const amount = req.query.amount || 3;
    const cacheKey = `${id}:${amount}`;

    if (!circuitBreaker.canRequest()) {
      const stale = upcomingCache.getStale(cacheKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "SERVICE_DEGRADED");
    }

    try {
      const entry = await upcomingCache.dedupe(cacheKey, async () => {
        const token = await getToken();
        const r = await withRetry(() =>
          axios.get(
            `${BASE}/buses/busstops/${id}/upcomingbuses?lines=${lines.join(",")}&amountPerLine=${amount}`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
          ),
          `/upcoming/${id}`
        );
        const { valid, rejected } = validateList(schemas.UpcomingBusSchema, r.data, `/upcoming/${id}`);
        if (rejected > 0) logger.info(`/upcoming/${id}: ${rejected} ETAs rechazadas`);
        return valid;
      });
      return sendCachedWrapped(req, res, entry, { source: "imm" });
    } catch (e) {
      logger.error(`/upcoming/${id} error: ${e.message}`);
      const stale = upcomingCache.getStale(cacheKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "IMM_UNAVAILABLE");
    }
  }

  // ── GET /busstops/:id/schedules ── (migrado)
  const schedulesMatch = url.match(/^\/busstops\/(\d+)\/schedules$/);
  if (schedulesMatch && req.method === "GET") {
    const id = schedulesMatch[1];
    const schedules = stopSchedules[id];
    if (!schedules) return ok(res, {}, { source: "gtfs" });

    // GTFS usa hora local Uruguay (UTC-3). El servidor corre en us-central1,
    // así que new Date().getHours() daría hora equivocada.
    const now = new Date();
    const uyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
    const currentMinutes = uyTime.getHours() * 60 + uyTime.getMinutes();

    const result = {};
    Object.entries(schedules).forEach(([line, times]) => {
      const upcoming = times
        .map(t => {
          const parts = t.split(":");
          const totalMinutes = parseInt(parts[0]) * 60 + parseInt(parts[1]);
          return { time: t, totalMinutes };
        })
        .filter(t => t.totalMinutes > currentMinutes)
        .slice(0, 3)
        .map(t => t.time);
      if (upcoming.length > 0) result[line] = upcoming;
    });

    const parsed = schemas.SchedulesSchema.safeParse(result);
    if (!parsed.success) {
      logger.error(`/schedules/${id} schema inválido: ${parsed.error.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
    return ok(res, parsed.data, { source: "gtfs" });
  }

  // ── GET /buses/linevariants ── (migrado)
  const lineVariantsMatch = url === "/buses/linevariants" && req.method === "GET";
  if (lineVariantsMatch) {
    if (!circuitBreaker.canRequest()) return fail(res, "SERVICE_DEGRADED");
    try {
      const token = await getToken();
      const r = await withRetry(() =>
        axios.get(`${BASE}/buses/linevariants`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000
        }),
        "/linevariants"
      );
      const { valid, rejected } = validateList(schemas.LineVariantSchema, r.data, "/linevariants");
      if (rejected > 0) logger.info(`/linevariants: ${rejected} variantes rechazadas`);
      return ok(res, valid, { source: "imm" });
    } catch (e) {
      logger.error(`/linevariants error: ${e.message}`);
      return fail(res, "IMM_UNAVAILABLE");
    }
  }

  // ── GET /places/autocomplete (Places API New) ── (migrado)
  if (url === "/places/autocomplete" && req.method === "GET") {
    const q = req.query.q;
    if (!q) return fail(res, "INVALID_REQUEST", "Falta parámetro 'q'");
    if (typeof q !== "string" || q.length > MAX_PLACES_QUERY_LEN) {
      return fail(res, "INVALID_REQUEST", "Parámetro 'q' inválido");
    }

    try {
      const body = {
        input: q,
        languageCode: "es",
        includedRegionCodes: ["uy"],
      };
      if (req.query.lat && req.query.lng) {
        const biasLat = parseFloat(req.query.lat);
        const biasLng = parseFloat(req.query.lng);
        if (inBoundsUY(biasLat, biasLng)) {
          body.locationBias = {
            circle: {
              center: { latitude: biasLat, longitude: biasLng },
              radius: 30000,
            },
          };
        } else {
          logger.warn(`/places/autocomplete locationBias descartado: ${biasLat},${biasLng}`);
        }
      }
      const r = await axios.post(`${GOOGLE_PLACES_NEW_BASE}/places:autocomplete`, body, {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleMapsKey.value(),
        },
        timeout: 5_000,
      });
      const predictions = (r.data.suggestions || []).map(s => {
        const p = s.placePrediction || {};
        return {
          placeId: p.placeId || "",
          mainText: p.structuredFormat?.mainText?.text || p.text?.text || "",
          secondaryText: p.structuredFormat?.secondaryText?.text || "",
          fullText: p.text?.text || "",
        };
      }).filter(p => p.placeId); // descartar sin placeId

      const parsed = schemas.AutocompleteResultSchema.safeParse({ predictions });
      if (!parsed.success) {
        logger.error(`/places/autocomplete schema: ${parsed.error.message}`);
        return fail(res, "INTERNAL_ERROR");
      }
      return ok(res, parsed.data, { source: "google" });
    } catch (e) {
      logger.error(`/places/autocomplete error: ${e.message}`);
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── GET /places/details (Places API New) ── (migrado)
  if (url === "/places/details" && req.method === "GET") {
    const placeId = req.query.placeId;
    if (!placeId) return fail(res, "INVALID_REQUEST", "Falta placeId");

    try {
      const r = await axios.get(`${GOOGLE_PLACES_NEW_BASE}/places/${placeId}`, {
        headers: {
          "X-Goog-Api-Key": googleMapsKey.value(),
          "X-Goog-FieldMask": "displayName,formattedAddress,location",
        },
        params: { languageCode: "es" },
        timeout: 5_000,
      });
      const place = r.data;
      if (!place) return fail(res, "NOT_FOUND", "Lugar no encontrado");
      const payload = {
        placeId,
        name: place.displayName?.text || "",
        address: place.formattedAddress || "",
        lat: place.location?.latitude || 0,
        lng: place.location?.longitude || 0,
      };
      const parsed = schemas.PlaceDetailsSchema.safeParse(payload);
      if (!parsed.success) {
        logger.error(`/places/details schema: ${parsed.error.message}`);
        return fail(res, "INTERNAL_ERROR");
      }
      return ok(res, parsed.data, { source: "google" });
    } catch (e) {
      if (e.response?.status === 404) return fail(res, "NOT_FOUND", "Lugar no encontrado");
      logger.error(`/places/details error: ${e.message}`);
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── POST /directions ── (migrado)
  if (url === "/directions" && req.method === "POST") {
    const { fromLat, fromLng, toLat, toLng } = req.body || {};
    if (!fromLat || !fromLng || !toLat || !toLng) {
      return fail(res, "INVALID_REQUEST", "Faltan coordenadas");
    }
    if (!inBoundsUY(Number(fromLat), Number(fromLng)) || !inBoundsUY(Number(toLat), Number(toLng))) {
      return fail(res, "INVALID_REQUEST", "Coordenadas fuera de rango");
    }

    // Redondear coords a 4 decimales (~11m precisión) para mejorar cache hit rate
    const roundedFrom = `${Number(fromLat).toFixed(4)},${Number(fromLng).toFixed(4)}`;
    const roundedTo = `${Number(toLat).toFixed(4)},${Number(toLng).toFixed(4)}`;
    const cacheKey = `${roundedFrom}>${roundedTo}`;

    try {
      const entry = await directionsCache.dedupe(cacheKey, async () => {
        const r = await axios.get(GOOGLE_DIRECTIONS_BASE, {
          params: {
            origin: `${fromLat},${fromLng}`,
            destination: `${toLat},${toLng}`,
            mode: "transit",
            alternatives: true,
            language: "es",
            key: googleMapsKey.value(),
          },
          timeout: 10_000,
        });
        const transformed = transformDirections(r.data);
        const parsed = schemas.DirectionsResultSchema.safeParse(transformed);
        if (!parsed.success) {
          logger.warn(`/directions schema parcial: ${parsed.error.message}`);
          return transformed; // devolver raw — directions puede variar mucho
        }
        return parsed.data;
      });
      return sendCachedWrapped(req, res, entry, { source: "google" });
    } catch (e) {
      logger.error(`/directions error: ${e.message}`);
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── GET /health ── (migrado al box sanitizador — piloto)
  if (url === "/health") {
    const raw = {
      stops: Object.keys(stopLines).length,
      schedules: Object.keys(stopSchedules).length,
      circuit: circuitBreaker.state,
      circuitFailures: circuitBreaker.failures,
      busesCache: busesCache.get("all") ? "hit" : "miss",
      upcomingCacheSize: upcomingCache.entries.size,
      directionsCacheSize: directionsCache.entries.size,
      rateLimitTracked: rateLimitMap.size,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    const parsed = schemas.HealthSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(`/health schema validation failed: ${parsed.error.message}`);
      return fail(res, "INTERNAL_ERROR", "Health payload no cumple schema");
    }
    return ok(res, parsed.data, { source: "computed" });
  }

  // ── POST /activity/register — push token de Live Activity ──
  // Fail-closed desde 2026-04-26: requiere idToken válido. iOS lo manda
  // siempre desde TripManager.sendPushTokenToBackend.
  if (url === "/activity/register" && req.method === "POST") {
    if (!req.auth?.uid) {
      return fail(res, "UNAUTHORIZED", "Falta idToken");
    }
    const { pushToken, activityId } = req.body || {};
    if (!pushToken) return fail(res, "INVALID_REQUEST", "Falta pushToken");
    const docId = activityId || pushToken.substring(0, 20);
    // Fire-and-forget: el consumer onAsyncWrite hace el set() async.
    publishAsyncWrite("activity-register", {
      docId,
      pushToken,
      activityId: activityId || "",
      ownerUid: req.auth.uid,
    });
    return ok(res, ack(), { source: "async" });
  }

  // ── POST /activity/deregister ──
  // Fail-closed: solo el dueño puede desregistrar su Live Activity.
  if (url === "/activity/deregister" && req.method === "POST") {
    if (!req.auth?.uid) {
      return fail(res, "UNAUTHORIZED", "Falta idToken");
    }
    const { activityId } = req.body || {};
    if (!activityId) return fail(res, "INVALID_REQUEST", "Falta activityId");
    try {
      const ref = db.collection("live_activity_tokens").doc(activityId);
      const snap = await ref.get();
      const ownerUid = snap.exists ? snap.data()?.ownerUid : null;
      if (ownerUid && ownerUid !== req.auth.uid) {
        logger.warn(`/activity/deregister ownership mismatch: doc=${ownerUid} caller=${req.auth.uid}`);
        return fail(res, "FORBIDDEN", "No sos el dueño de esta actividad");
      }
      await ref.update({ active: false });
      return ok(res, ack(), { source: "computed" });
    } catch (e) {
      logger.error(`/activity/deregister error: ${e.message}`);
      return fail(res, "INTERNAL_ERROR");
    }
  }

  // ── GET /weather/current?lat=X&lng=Y ── (Google Weather + grid cache 2km)
  //
  // Estrategia Opción C (ver memoria project_vamo_weather): snapeamos las
  // coords del usuario a una celda ~2km y cacheamos por celda 15 min. Miles
  // de usuarios en Pocitos comparten la misma query a Google. Damos precisión
  // de barrio sin multiplicar el costo.
  if (url === "/weather/current" && req.method === "GET") {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return fail(res, "INVALID_REQUEST", "Falta lat o lng");
    }
    if (!inBoundsUY(lat, lng)) {
      return fail(res, "INVALID_REQUEST", "Coordenadas fuera de rango");
    }

    // Snap a grid ~2km — coords del CENTRO de la celda, no del usuario.
    const gLat = Math.round(lat / WEATHER_GRID_LAT) * WEATHER_GRID_LAT;
    const gLng = Math.round(lng / WEATHER_GRID_LNG) * WEATHER_GRID_LNG;
    const cellKey = `${gLat.toFixed(4)}_${gLng.toFixed(4)}`;

    try {
      const entry = await weatherCache.dedupe(cellKey, async () => {
        const r = await axios.get(`${GOOGLE_WEATHER_BASE}/currentConditions:lookup`, {
          params: {
            key: googleMapsKey.value(),
            "location.latitude":  gLat,
            "location.longitude": gLng,
            unitsSystem: "METRIC",
            languageCode: "es-419",
          },
          timeout: 8_000,
        });
        const adapted = adaptWeatherCurrent(r.data);
        const parsed = schemas.WeatherCurrentSchema.safeParse(adapted);
        if (!parsed.success) {
          logger.warn(`/weather/current schema: ${parsed.error.message}`);
          return adapted; // devolvemos aunque no valide estricto
        }
        return parsed.data;
      });
      return sendCachedWrapped(req, res, entry, { source: "google" });
    } catch (e) {
      logger.error(`/weather/current error: ${e.message}`);
      // Fallback a cache stale si existe
      const stale = weatherCache.getStale(cellKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── GET /weather/forecast/hourly?lat=X&lng=Y&hours=24 ── (B2)
  //
  // Pronóstico horario hasta 240h (10 días). Default 24h. Mismo grid 2km
  // que /weather/current; cache 30 min porque el forecast cambia más lento
  // que el current. Si Google falla, fallback a stale del cache.
  if (url === "/weather/forecast/hourly" && req.method === "GET") {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const requestedHours = parseInt(req.query.hours, 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return fail(res, "INVALID_REQUEST", "Falta lat o lng");
    }
    if (!inBoundsUY(lat, lng)) {
      return fail(res, "INVALID_REQUEST", "Coordenadas fuera de rango");
    }
    // Clamp hours [1, 240]; default 24
    const hours = Number.isFinite(requestedHours)
      ? Math.min(240, Math.max(1, requestedHours))
      : 24;

    const gLat = Math.round(lat / WEATHER_GRID_LAT) * WEATHER_GRID_LAT;
    const gLng = Math.round(lng / WEATHER_GRID_LNG) * WEATHER_GRID_LNG;
    const cellKey = `hourly_${hours}_${gLat.toFixed(4)}_${gLng.toFixed(4)}`;

    try {
      const entry = await weatherForecastCache.dedupe(cellKey, async () => {
        const r = await axios.get(`${GOOGLE_WEATHER_BASE}/forecast/hours:lookup`, {
          params: {
            key: googleMapsKey.value(),
            "location.latitude":  gLat,
            "location.longitude": gLng,
            unitsSystem: "METRIC",
            languageCode: "es-419",
            hours,
          },
          timeout: 10_000,
        });
        const adapted = adaptWeatherForecastHourly(r.data);
        const parsed = schemas.WeatherForecastHourlySchema.safeParse(adapted);
        if (!parsed.success) {
          logger.warn(`/weather/forecast/hourly schema: ${parsed.error.message}`);
          return adapted;
        }
        return parsed.data;
      });
      return sendCachedWrapped(req, res, entry, { source: "google" });
    } catch (e) {
      logger.error(`/weather/forecast/hourly error: ${e.message}`);
      const stale = weatherForecastCache.getStale(cellKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── GET /weather/forecast/daily?lat=X&lng=Y&days=10 ── (B3)
  //
  // Pronóstico diario hasta 10 días. Default 10. Cache 30 min. Incluye
  // sunrise/sunset/moonrise/moonset/moonPhase del día[0] que el cliente
  // cruza con el current para tener la data completa.
  if (url === "/weather/forecast/daily" && req.method === "GET") {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const requestedDays = parseInt(req.query.days, 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return fail(res, "INVALID_REQUEST", "Falta lat o lng");
    }
    if (!inBoundsUY(lat, lng)) {
      return fail(res, "INVALID_REQUEST", "Coordenadas fuera de rango");
    }
    const days = Number.isFinite(requestedDays)
      ? Math.min(10, Math.max(1, requestedDays))
      : 10;

    const gLat = Math.round(lat / WEATHER_GRID_LAT) * WEATHER_GRID_LAT;
    const gLng = Math.round(lng / WEATHER_GRID_LNG) * WEATHER_GRID_LNG;
    const cellKey = `daily_${days}_${gLat.toFixed(4)}_${gLng.toFixed(4)}`;

    try {
      const entry = await weatherForecastCache.dedupe(cellKey, async () => {
        const r = await axios.get(`${GOOGLE_WEATHER_BASE}/forecast/days:lookup`, {
          params: {
            key: googleMapsKey.value(),
            "location.latitude":  gLat,
            "location.longitude": gLng,
            unitsSystem: "METRIC",
            languageCode: "es-419",
            days,
          },
          timeout: 10_000,
        });
        const adapted = adaptWeatherForecastDaily(r.data);
        const parsed = schemas.WeatherForecastDailySchema.safeParse(adapted);
        if (!parsed.success) {
          logger.warn(`/weather/forecast/daily schema: ${parsed.error.message}`);
          return adapted;
        }
        return parsed.data;
      });
      return sendCachedWrapped(req, res, entry, { source: "google" });
    } catch (e) {
      logger.error(`/weather/forecast/daily error: ${e.message}`);
      const stale = weatherForecastCache.getStale(cellKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── GET /air-quality/current?lat=X&lng=Y ── (B4)
  //
  // Calidad del aire actual via Google Air Quality API (POST request,
  // distinta a Weather API). Cache server-side 1h porque cambia lento
  // y la API factura por call. Devuelve UAQI 0-100, categoría, color
  // y opcionalmente pollutants individuales.
  if (url === "/air-quality/current" && req.method === "GET") {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return fail(res, "INVALID_REQUEST", "Falta lat o lng");
    }
    if (!inBoundsUY(lat, lng)) {
      return fail(res, "INVALID_REQUEST", "Coordenadas fuera de rango");
    }

    // Mismo grid 2km que weather — ahorra calls compartiendo celda.
    const gLat = Math.round(lat / WEATHER_GRID_LAT) * WEATHER_GRID_LAT;
    const gLng = Math.round(lng / WEATHER_GRID_LNG) * WEATHER_GRID_LNG;
    const cellKey = `${gLat.toFixed(4)}_${gLng.toFixed(4)}`;

    try {
      const entry = await airQualityCache.dedupe(cellKey, async () => {
        const r = await axios.post(
          `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${googleMapsKey.value()}`,
          {
            location: { latitude: gLat, longitude: gLng },
            extraComputations: [
              "POLLUTANT_CONCENTRATION",
              "HEALTH_RECOMMENDATIONS",
              "LOCAL_AQI",
            ],
            languageCode: "es-419",
            universalAqi: true,
          },
          { timeout: 10_000 }
        );
        const adapted = adaptAirQuality(r.data);
        const parsed = schemas.AirQualityCurrentSchema.safeParse(adapted);
        if (!parsed.success) {
          logger.warn(`/air-quality/current schema: ${parsed.error.message}`);
          return adapted;
        }
        return parsed.data;
      });
      return sendCachedWrapped(req, res, entry, { source: "google" });
    } catch (e) {
      logger.error(`/air-quality/current error: ${e.message}`);
      const stale = airQualityCache.getStale(cellKey);
      if (stale) return sendCachedWrapped(req, res, stale, { source: "cache", stale: true });
      return fail(res, "GOOGLE_UNAVAILABLE");
    }
  }

  // ── POST /user/fcm-token — FCM token para push notifications ──
  // Fail-closed desde 2026-04-26: requiere idToken válido. iOS lo manda
  // siempre desde PushNotificationManager.saveFCMToken.
  if (url === "/user/fcm-token" && req.method === "POST") {
    if (!req.auth?.uid) {
      return fail(res, "UNAUTHORIZED", "Falta idToken");
    }
    const { userId: bodyUserId, fcmToken } = req.body || {};
    if (!fcmToken) return fail(res, "INVALID_REQUEST", "Falta fcmToken");

    // Si el body trae userId, debe coincidir con el del token. Esto bloquea
    // un caller con token A intentando registrar el fcmToken bajo uid B.
    if (bodyUserId && req.auth.uid !== bodyUserId) {
      logger.warn(`/user/fcm-token uid mismatch: token=${req.auth.uid} body=${bodyUserId}`);
      return fail(res, "FORBIDDEN", "uid no coincide con el token");
    }
    const userId = req.auth.uid;

    // Fire-and-forget: publica a Pub/Sub, retorna 200 inmediato.
    // El consumer onAsyncWrite hace el set() a Firestore async.
    publishAsyncWrite("fcm-token", { userId, fcmToken });
    return ok(res, ack(), { source: "async" });
  }

  return fail(res, "NOT_FOUND");
});

// ─────────────────────────────────────────────────────────────────
// Scheduled: limpiar docs de community_buses huérfanos
// ─────────────────────────────────────────────────────────────────
//
// Cuando un usuario mata la app sin cerrar el reporte, el doc en
// Firestore queda huérfano. El isStale (>90s) evita que se muestre,
// pero los docs se acumulan y aumentan costos de lectura del listener.
//
// Este job corre cada 10 minutos y borra docs con updatedAt > 3 min.

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────
// Scheduled: push Live Activity updates cada 15s
// ─────────────────────────────────────────────────────────────────
//
// Lee todos los tokens activos de Firestore, obtiene datos frescos
// de buses, y envía push updates al APNs de Apple para actualizar
// Live Activities en lock screen sin que la app esté abierta.
//
// Live Activity push via APNs — actualiza Live Activities en lock screen
// sin necesidad de que la app esté abierta.
const apnsKey = defineSecret("APNS_KEY");
const APNS_KEY_ID = "U73Z3AS9SC";
const APNS_TEAM_ID = "6DJ7QPWLB5";
const APNS_TOPIC = "uy.com.vamo.Vamo.push-type.liveactivity";

function buildApnsJwt(keyPem) {
  const jwt = require("jsonwebtoken");
  return jwt.sign({}, keyPem, {
    algorithm: "ES256",
    keyid: APNS_KEY_ID,
    issuer: APNS_TEAM_ID,
    expiresIn: "1h",
    header: { alg: "ES256", kid: APNS_KEY_ID },
  });
}

exports.pushLiveActivityUpdates = onSchedule(
  { schedule: "every 1 minutes", memory: "256MiB", timeoutSeconds: 30, secrets: [apnsKey] },
  async () => {
    const tokens = await db.collection("live_activity_tokens")
      .where("active", "==", true).get();
    if (tokens.empty) return;

    const keyPem = apnsKey.value();
    if (!keyPem) { logger.error("APNS_KEY secret is empty"); return; }

    let jwtToken;
    try {
      jwtToken = buildApnsJwt(keyPem);
    } catch (e) {
      logger.error(`Failed to build APNs JWT: ${e.message}`);
      return;
    }

    // Fetch fresh bus data for the push payload
    // The content-state must match TripActivityAttributes.ContentState
    // For now, send a heartbeat that keeps the activity alive
    const timestamp = Math.floor(Date.now() / 1000);

    for (const doc of tokens.docs) {
      const { pushToken } = doc.data();
      if (!pushToken) continue;

      try {
        const payload = JSON.stringify({
          aps: {
            timestamp,
            event: "update",
            "content-state": {
              // Minimal heartbeat — keeps the activity from going stale
              // The app will fill real data when it comes to foreground
              stepKind: "bus",
              headline: "Actualizando...",
              detailLine: "",
              lineNumber: "",
              lineColorHex: "",
              company: "",
              arrivalTime: "",
              stepRemainingMin: 0,
              stepProgress: 0,
              currentStepIndex: 0,
              totalSteps: 1,
            },
            "alert": {
              title: "Vamo",
              body: "Tu viaje se está actualizando"
            }
          }
        });

        const response = await axios.post(
          `https://api.push.apple.com/3/device/${pushToken}`,
          payload,
          {
            headers: {
              "authorization": `bearer ${jwtToken}`,
              "apns-topic": APNS_TOPIC,
              "apns-push-type": "liveactivity",
              "apns-priority": "10",
              "content-type": "application/json",
            },
            timeout: 5000,
          }
        );
        logger.info(`Push sent to activity ${doc.id}: ${response.status}`);
      } catch (e) {
        const status = e.response?.status;
        if (status === 410) {
          // Token is no longer valid — mark inactive
          await doc.ref.update({ active: false });
          logger.info(`Deactivated expired activity ${doc.id}`);
        } else {
          logger.error(`Push failed for ${doc.id}: ${status || e.message}`);
        }
      }
    }
  }
);

exports.cleanupStaleCommunityBuses = onSchedule(
  { schedule: "every 10 minutes", memory: "256MiB", timeoutSeconds: 60 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 3 * 60 * 1000) // 3 minutos
    );

    const snapshot = await db
      .collection("community_buses")
      .where("updatedAt", "<", cutoff)
      .limit(500) // batch limit para evitar timeout
      .get();

    if (snapshot.empty) {
      logger.info("Cleanup: no stale community docs");
      return;
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    logger.info(`Cleanup: deleted ${snapshot.size} stale community docs`);
  }
);

// ─────────────────────────────────────────────────────────────────
// Trigger: alert created/updated → send FCM push
// ─────────────────────────────────────────────────────────────────
//
// Dashboard escribe a `alerts/{id}` con sendPush=true, active=true.
// Esta función detecta el cambio y envía FCM a los topics correspondientes:
//   - Si affectedLines está vacío → topic "alerts" (todos suscritos)
//   - Si tiene líneas → topic "line_XXX" por cada línea
// Después marca pushSent=true para evitar reenvíos.

function severityToApnsInterruption(severity) {
  return severity === "critical" ? "time-sensitive" : "active";
}

function severityToAndroidPriority(severity) {
  return severity === "critical" ? "high" : "normal";
}

exports.onAlertWrite = onDocumentWritten(
  { document: "alerts/{alertId}", memory: "256MiB" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // doc eliminado

    // Solo disparar si sendPush && active && !pushSent
    if (!after.sendPush || !after.active || after.pushSent) {
      return;
    }

    const alertId = event.params.alertId;
    const notification = {
      title: after.title || "Alerta de Vamo",
      body: after.body || "",
    };
    const data = {
      alertId,
      type: String(after.type || "info"),
      severity: String(after.severity || "info"),
    };

    const apnsInterruption = severityToApnsInterruption(after.severity);
    const androidPriority = severityToAndroidPriority(after.severity);

    const messaging = admin.messaging();
    const messages = [];

    if (!after.affectedLines || after.affectedLines.length === 0) {
      // Sistema-wide → topic "alerts"
      messages.push({
        topic: "alerts",
        notification,
        data,
        apns: {
          payload: {
            aps: { "interruption-level": apnsInterruption, sound: "default" },
          },
        },
        android: { priority: androidPriority },
      });
    } else {
      // Por línea → topic "line_XXX" por cada una
      for (const line of after.affectedLines) {
        messages.push({
          topic: `line_${line}`,
          notification,
          data: { ...data, line: String(line) },
          apns: {
            payload: {
              aps: { "interruption-level": apnsInterruption, sound: "default" },
            },
          },
          android: { priority: androidPriority },
        });
      }
    }

    try {
      const results = await Promise.all(
        messages.map((m) => messaging.send(m).catch((e) => ({ error: e.message })))
      );
      const failures = results.filter((r) => r && r.error);
      logger.info(
        `Alert ${alertId}: FCM sent to ${messages.length} topics, ${failures.length} errors`
      );
      await event.data.after.ref.update({
        pushSent: true,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error(`Failed to send FCM for alert ${alertId}:`, err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// GET /admin/briefing — genera un briefing con Gemini
// ─────────────────────────────────────────────────────────────────
//
// Llamado desde el dashboard. Toma un snapshot del estado del sistema
// (buses, alertas, reportes) y le pide a Gemini un resumen tipo ops.
// Por ahora sin auth — protegido por CORS + dominio de llamada.

const { GoogleGenAI } = require("@google/genai");
const GEMINI_MODEL = "gemini-2.0-flash-exp";

exports.adminBriefing = onRequest(
  {
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [geminiApiKey],
  },
  async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json(fail(res, "METHOD_NOT_ALLOWED"));
    }

    // Shadow auth — el Dashboard productivo aún no manda idToken. IAP en
    // Auth fail-closed: solo emails @neodimio.com.uy verificados pueden invocar.
    // Reemplaza el "shadow auth" anterior que loguaba pero no rechazaba —
    // ese era launch-blocker (gasto cuota Gemini + leak de telemetría operativa).
    const ok = await requireAdminEmail(req, res);
    if (!ok) return; // requireAdminEmail ya escribió la respuesta 401/403

    try {
      // Recibir context del dashboard
      const context = req.method === "POST" ? req.body : {
        buses: 0,
        companies: {},
        alerts: { active: 0, critical: 0, titles: [] },
        community: 0,
        overrides: 0,
        suspendedStops: 0,
        anomalies: [],
      };

      const hour = new Date().getUTCHours() - 3; // UY UTC-3
      const adjHour = ((hour % 24) + 24) % 24;
      const timeOfDay =
        adjHour < 6 ? "madrugada" :
        adjHour < 12 ? "mañana" :
        adjHour < 19 ? "tarde" : "noche";

      const prompt = `Sos el asistente de operaciones de Vamo, una app de transporte público para Montevideo.
Generá un briefing CONCISO y EJECUTIVO del estado actual del sistema para el equipo de Neodimio.

Hora: ${timeOfDay} (${adjHour}:00 UY)

Datos en vivo:
- Buses activos: ${context.buses}
- Distribución por empresa: ${JSON.stringify(context.companies)}
- Alertas activas: ${context.alerts?.active || 0} (${context.alerts?.critical || 0} críticas)
- Títulos de alertas: ${(context.alerts?.titles || []).join("; ") || "ninguna"}
- Reportes comunidad: ${context.community}
- Paradas con overrides: ${context.overrides}
- Paradas suspendidas: ${context.suspendedStops}
- Anomalías detectadas: ${(context.anomalies || []).map(a => a.title).join("; ") || "ninguna"}

Instrucciones:
1. 2-3 oraciones cortas, tono profesional pero cercano (es-UY, usar "vos")
2. Destacar lo importante primero (crítico > anomalías > operación normal)
3. Si hay alertas críticas o anomalías → mencionar con "atender" o "prioridad"
4. Si todo está normal → reconocerlo brevemente
5. No usar markdown, no usar emojis, no poner encabezados
6. Final: 2-3 bullets cortos con "Prioridades" si corresponde, separados por |

Formato: { "summary": "<texto narrativo>", "highlights": ["bullet 1", "bullet 2"] }
Responder SOLO JSON válido.`;

      // Secret Manager primero, env var como fallback dev (emulator).
      let apiKey = "";
      try { apiKey = geminiApiKey.value(); } catch (_) { /* sin secret en context */ }
      if (!apiKey) apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
      if (!apiKey) {
        // Fallback si no hay key: template determinístico
        return res.json({
          ok: true,
          data: fallbackBriefing(context),
          meta: { source: "template", version: "1" },
        });
      }

      const genAI = new GoogleGenAI({ apiKey });
      const response = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
      });

      const text = response.text || "";

      // Intentar parsear JSON
      let result;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: text, highlights: [] };
      } catch {
        result = { summary: text, highlights: [] };
      }

      return res.json({
        ok: true,
        data: result,
        meta: { source: "gemini", model: GEMINI_MODEL, version: "1" },
      });
    } catch (err) {
      logger.error("Briefing error:", err);
      return res.status(500).json({
        ok: false,
        error: { code: "BRIEFING_FAILED", message: err.message },
      });
    }
  }
);

function fallbackBriefing(ctx) {
  const parts = [];
  parts.push(`Hay ${ctx.buses} buses en vivo en el sistema.`);
  if (ctx.alerts?.critical > 0) {
    parts.push(`Hay ${ctx.alerts.critical} alerta${ctx.alerts.critical !== 1 ? "s" : ""} crítica${ctx.alerts.critical !== 1 ? "s" : ""} que requieren atención.`);
  } else if (ctx.alerts?.active > 0) {
    parts.push(`Hay ${ctx.alerts.active} alerta${ctx.alerts.active !== 1 ? "s" : ""} activa${ctx.alerts.active !== 1 ? "s" : ""}.`);
  } else {
    parts.push("No hay alertas activas.");
  }
  if (ctx.community > 0) {
    parts.push(`La comunidad reporta ${ctx.community} viajes en vivo.`);
  }
  const highlights = [];
  if (ctx.alerts?.critical > 0) highlights.push(`Atender ${ctx.alerts.critical} alertas críticas`);
  if ((ctx.anomalies || []).length > 0) highlights.push("Revisar anomalías del sistema");
  return { summary: parts.join(" "), highlights };
}

// ─────────────────────────────────────────────────────────────────
// Connections — aceptar invitación de contacto
// ─────────────────────────────────────────────────────────────────
//
// Callable function. Cliente iOS llama desde `ConnectionsStore.acceptInvitation`
// con `{ code: "ABC123" }`. Validamos atomicamente:
//   1. Auth presente y NO anónimo (los anónimos no tienen identidad para
//      ser contactos persistentes).
//   2. La invitación existe, no expiró, no fue usada.
//   3. El que acepta no es el mismo que invitó (self-invitation).
//   4. No están ya conectados.
// Si todo valida, escribimos las DOS puntas del grafo de contactos
// (subcolección `contacts` de cada user) + marcamos la invitación como
// consumida en una sola transacción.
//
// Devolvemos `{ ok: true, contactUid }` o un HttpsError con `details.reason`
// que el cliente mapea a un mensaje localizado.
exports.acceptContactInvitation = onCall(
  { memory: "256MiB", timeoutSeconds: 15 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Auth required");
    }
    const provider = request.auth?.token?.firebase?.sign_in_provider;
    if (provider === "anonymous") {
      throw new HttpsError(
        "permission-denied",
        "Requires full account",
        { reason: "requires_full_account" }
      );
    }

    const code = String(request.data?.code || "").toUpperCase();
    if (!code || code.length !== 6) {
      throw new HttpsError("invalid-argument", "Invalid code", { reason: "not_found" });
    }

    const inviteRef = db.collection("contact_invitations").doc(code);

    // Pre-fetch del receptor FUERA de la transacción. La call a
    // admin.auth().getUser() puede tardar 100-500ms — dentro de la TX
    // contribuiría al timeout (default Firestore TX = 60s, pero la latencia
    // se multiplica si la TX retry-ea por contención). Acá no hay race risk:
    // los datos del propio user no cambian entre TX-attempts.
    const receiver = await admin.auth().getUser(uid);
    const receiverDisplayName = receiver.displayName || "Usuario de Vamo";
    const receiverEmail = receiver.email || null;

    // Race condition protection: el `tx.update(inviteRef, { acceptedBy })`
    // hace que Firestore aborte/retry cualquier TX concurrente que haya
    // leído el mismo invitation doc. Si dos requests aceptan la misma
    // invitación al mismo tiempo, uno commitea, el otro retry-ea y al
    // re-leer ve `acceptedBy != null` → throws "already_used".
    return await db.runTransaction(async (tx) => {
      const inviteSnap = await tx.get(inviteRef);
      if (!inviteSnap.exists) {
        throw new HttpsError("not-found", "Invitation not found", { reason: "not_found" });
      }
      const invitation = inviteSnap.data();

      if (invitation.acceptedBy || invitation.rejected) {
        throw new HttpsError("failed-precondition", "Already used", { reason: "already_used" });
      }

      const now = admin.firestore.Timestamp.now();
      if (invitation.expiresAt && invitation.expiresAt.toMillis() < now.toMillis()) {
        throw new HttpsError("failed-precondition", "Expired", { reason: "expired" });
      }

      if (invitation.fromUid === uid) {
        throw new HttpsError(
          "failed-precondition",
          "Self invitation",
          { reason: "self_invitation" }
        );
      }

      // Validar no estar ya conectado (status active).
      const existingFromSenderRef = db.collection("user_connections")
        .doc(invitation.fromUid).collection("contacts").doc(uid);
      const existingSnap = await tx.get(existingFromSenderRef);
      if (existingSnap.exists && existingSnap.data().status === "active") {
        throw new HttpsError(
          "failed-precondition",
          "Already connected",
          { reason: "already_connected" }
        );
      }

      // Escribir las dos puntas del grafo + consumir la invitación.
      const senderToReceiverRef = db.collection("user_connections")
        .doc(invitation.fromUid).collection("contacts").doc(uid);
      const receiverToSenderRef = db.collection("user_connections")
        .doc(uid).collection("contacts").doc(invitation.fromUid);

      tx.set(senderToReceiverRef, {
        displayName: receiverDisplayName,
        email: receiverEmail,
        status: "active",
        since: now,
      });
      tx.set(receiverToSenderRef, {
        displayName: invitation.fromDisplayName || "Usuario de Vamo",
        email: invitation.fromEmail || null,
        status: "active",
        since: now,
      });
      tx.update(inviteRef, {
        acceptedBy: uid,
        acceptedAt: now,
      });

      logger.info(`Contact connection: ${invitation.fromUid} <-> ${uid} via code ${code}`);

      return { ok: true, contactUid: invitation.fromUid };
    });
  }
);

// ─────────────────────────────────────────────────────────────────
// Referrals — canjear código de invitación a la app
// ─────────────────────────────────────────────────────────────────
//
// Callable. Cliente iOS llama desde `ReferralStore.redeemCode` con
// `{ code: "ABC123", source: "manual" | "deeplink" }`. Validamos:
//   1. Auth presente y no anónimo.
//   2. Código existe en `referral_codes/{code}`.
//   3. El código no es del propio user (self-referral).
//   4. El user no canjeó ya otro código antes (un referido por cuenta).
// Si todo valida, escribe `referrals/{eventId}` + incrementa
// `referral_codes/{code}.signups` atomicamente.
exports.redeemReferralCode = onCall(
  { memory: "256MiB", timeoutSeconds: 15 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Auth required");
    }
    const provider = request.auth?.token?.firebase?.sign_in_provider;
    if (provider === "anonymous") {
      throw new HttpsError(
        "permission-denied",
        "Requires full account",
        { reason: "requires_full_account" }
      );
    }

    const code = String(request.data?.code || "").toUpperCase();
    const source = String(request.data?.source || "manual");
    if (!code || code.length !== 6) {
      throw new HttpsError("invalid-argument", "Invalid code", { reason: "not_found" });
    }

    const codeRef = db.collection("referral_codes").doc(code);
    // Doc determinístico por user → garantiza unicidad atómica desde Firestore.
    // El uid del user redentor es la primary key del referral. Si dos requests
    // concurrentes intentan canjear, el segundo falla en tx.get porque ve la
    // versión del primero (within transaction snapshot isolation).
    const eventRef = db.collection("referrals").doc(uid);

    return await db.runTransaction(async (tx) => {
      // 1. Chequeo de unicidad DENTRO de la transacción (era la race condition
      //    crítica: el query previo a la TX permitía dobles canjes en burst).
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Already redeemed",
          { reason: "already_redeemed" }
        );
      }

      // 2. Validar el código.
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists) {
        throw new HttpsError("not-found", "Code not found", { reason: "not_found" });
      }
      const codeData = codeSnap.data();
      if (codeData.ownerUid === uid) {
        throw new HttpsError(
          "failed-precondition",
          "Self code",
          { reason: "self_code" }
        );
      }

      // 3. Persistir el redemption + bump signups del code, todo atómico.
      tx.set(eventRef, {
        referrerUid: codeData.ownerUid,
        referredUid: uid,
        code,
        referredAt: admin.firestore.Timestamp.now(),
        source,
      });
      tx.update(codeRef, {
        signups: admin.firestore.FieldValue.increment(1),
      });

      logger.info(`Referral redeemed: ${codeData.ownerUid} -> ${uid} via ${code}`);

      return { ok: true, referrerUid: codeData.ownerUid };
    });
  }
);

// ─────────────────────────────────────────────────────────────────
// Borrado de cuenta: cascada Firestore + Storage + Auth atómica
// (Apple Review Guideline 5.1.1(v) launch-blocker)
// ─────────────────────────────────────────────────────────────────
const { deleteMyAccount } = require("./lib/triggers/on-user-delete");
exports.deleteMyAccount = deleteMyAccount;

// ─────────────────────────────────────────────────────────────────
// Shared Trips — push a recipientes en eventos clave
// ─────────────────────────────────────────────────────────────────
//
// Trigger sobre `shared_trips/{shareId}`:
// - onCreate: notifica a TODOS los recipients que el dueño está
//   compartiendo un viaje con ellos.
// - onUpdate: notifica solo si cambió el status a "approaching_destination"
//   o "arrived" (los dos eventos relevantes para el receptor).
//
// Mensajes usan FCM directo a `user_tokens/{uid}` por cada recipient.

async function fcmTokensFor(uids) {
  if (!uids || uids.length === 0) return [];
  const tokens = [];
  // Firestore in() acepta hasta 30 valores; para más, chunk-eamos.
  for (let i = 0; i < uids.length; i += 30) {
    const chunk = uids.slice(i, i + 30);
    const snap = await db.collection("user_tokens")
      .where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken) tokens.push(data.fcmToken);
    });
  }
  return tokens;
}

async function sendSharedTripPush(uids, title, body, shareId) {
  const tokens = await fcmTokensFor(uids);
  if (tokens.length === 0) return;
  const messaging = admin.messaging();
  const messages = tokens.map(token => ({
    token,
    notification: { title, body },
    data: { type: "shared_trip", shareId: String(shareId) },
    apns: {
      payload: {
        aps: { "interruption-level": "active", sound: "default" },
      },
    },
    android: { priority: "high" },
  }));
  try {
    const response = await messaging.sendEach(messages);
    logger.info(`Shared trip push: success=${response.successCount} fail=${response.failureCount}`);
  } catch (e) {
    logger.error(`Shared trip push error: ${e.message}`);
  }
}

exports.onSharedTripCreated = onDocumentCreated(
  { document: "shared_trips/{shareId}" },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    // Incrementar counter del owner (incluye planned_trip + live_trip).
    if (data.ownerId) {
      await incrementUserStat(data.ownerId, "sharedTrips");
    }

    if (data.type !== "live_trip") return;  // planned_trip se notifica distinto

    const recipientIds = Array.isArray(data.recipientIds) ? data.recipientIds : [];
    if (recipientIds.length === 0) return;

    const ownerName = data.ownerDisplayName || "Tu contacto";
    const line = data.busLine || "";
    const dest = data.busDestination || "";
    const title = `${ownerName} está compartiendo un viaje`;
    const body = line && dest
      ? `Va en la línea ${line} hacia ${dest}.`
      : `Tocá para ver dónde está.`;

    await sendSharedTripPush(recipientIds, title, body, event.params.shareId);
  }
);

exports.onSharedTripStatusChanged = onDocumentUpdated(
  { document: "shared_trips/{shareId}" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.status === after.status) return;
    if (after.type !== "live_trip") return;

    const recipientIds = Array.isArray(after.recipientIds) ? after.recipientIds : [];
    if (recipientIds.length === 0) return;

    const ownerName = after.ownerDisplayName || "Tu contacto";
    const stop = after.destinationStopName || "su parada";
    let title = "";
    let body = "";

    if (after.status === "approaching_destination") {
      title = `${ownerName} está por llegar`;
      body = `Va a bajarse en ${stop}.`;
    } else if (after.status === "arrived") {
      title = `${ownerName} llegó`;
      body = `Bajó en ${stop}.`;
    } else {
      return;
    }

    await sendSharedTripPush(recipientIds, title, body, event.params.shareId);
  }
);

// =============================================================================
// SOPORTE — push notifications + telemetry
// =============================================================================
//
// Tickets en `support_tickets/{ticketId}` con array embedded `replies[]`.
// Schema en `Vamo/Models/SupportTicket.swift` y `mvd-proxy/admin/src/lib/...`.
//
// Mecanismo de notificación al ADMIN:
//   1. Activity event (`activity_events`) → el dashboard tiene NotificationBell
//      que ya lo consume y muestra badge en tiempo real (sin trabajo extra).
//   2. FCM topic "admin_support" → cualquier device (iOS o web SDK) suscrito
//      al topic recibe push. La suscripción la hace el cliente cuando detecta
//      email @neodimio.com.uy en login.
//
// Mecanismo de notificación al USER:
//   - FCM directo a `user_tokens/{uid}` cuando el admin responde algo
//     non-internal en un ticket.
//
// Telemetry:
//   - Todos los intentos de push se loguean en `push_events` para visibilidad
//     desde el dashboard (qué se envió, a quién, exitoso o no).

/// Registra un evento de push en la colección `push_events` para auditoría
/// y debugging desde el dashboard. Best-effort: no abortamos el flow si falla.
async function logPushEvent(payload) {
  try {
    await db.collection("push_events").add({
      ...payload,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn(`logPushEvent failed: ${e.message}`);
  }
}

/// Manda un push FCM al topic "admin_support" — los devices admin que se
/// suscriben (iOS al login con @neodimio.com.uy) lo reciben. Sin error si
/// no hay suscriptores.
async function pushToAdminTopic(title, body, dataPayload) {
  try {
    const messaging = admin.messaging();
    await messaging.send({
      topic: "admin_support",
      notification: { title, body },
      data: dataPayload,
      apns: {
        payload: { aps: { "interruption-level": "active", sound: "default" } },
      },
      android: { priority: "high" },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/// Helper para incrementar un contador en users/{uid}.stats sin romper
/// si el doc no existe — usa setDoc(merge=true) que crea/actualiza.
async function incrementUserStat(uid, statKey) {
  if (!uid) return;
  try {
    await db.collection("users").doc(uid).set(
      { stats: { [statKey]: admin.firestore.FieldValue.increment(1) } },
      { merge: true }
    );
  } catch (e) {
    logger.warn(`incrementUserStat ${uid}.${statKey} failed: ${e.message}`);
  }
}

/// Trigger para incrementar el counter `communityReports` del user que
/// reporta su bus. Sirve al dashboard /users para mostrar cuántos reportes
/// hizo cada user (insumo para detección de spammers).
exports.onCommunityBusCreated = onDocumentCreated(
  { document: "community_buses/{docId}" },
  async (event) => {
    const data = event.data?.data();
    if (!data?.userId) return;
    await incrementUserStat(data.userId, "communityReports");
  }
);

exports.onSupportTicketCreated = onDocumentCreated(
  { document: "support_tickets/{ticketId}" },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const ticketId = event.params.ticketId;
    const subject = (data.subject || "(sin asunto)").slice(0, 80);
    const userLabel = data.userName || data.userEmail || "Usuario anónimo";

    // Incrementar counter en users/{uid}.stats.supportTickets para que
    // el dashboard /users muestre cuántos tickets abrió cada user.
    await incrementUserStat(data.userId, "supportTickets");

    // 1. Activity event para que el NotificationBell del dashboard lo muestre.
    await db.collection("activity_events").add({
      kind: "support_new_ticket",
      summary: `Nuevo ticket de soporte: "${subject}"`,
      actor: data.userEmail || "anonymous",
      ticketId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. FCM al topic admin (si hay suscriptores).
    const pushResult = await pushToAdminTopic(
      "Nuevo ticket de soporte",
      `${userLabel}: ${subject}`,
      { type: "support_new_ticket", ticketId }
    );

    // 3. Telemetry.
    await logPushEvent({
      type: "support_new_ticket",
      ticketId,
      mechanisms: ["activity_event", pushResult.ok ? "fcm_topic" : "fcm_topic_failed"],
      status: pushResult.ok ? "sent" : "partial",
      error: pushResult.error || null,
    });
  }
);

exports.onSupportTicketUpdated = onDocumentUpdated(
  { document: "support_tickets/{ticketId}" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;

    const beforeReplies = Array.isArray(before.replies) ? before.replies : [];
    const afterReplies = Array.isArray(after.replies) ? after.replies : [];
    // Solo nos interesa cuando se agregó al menos una reply nueva.
    if (afterReplies.length <= beforeReplies.length) return;
    const newReply = afterReplies[afterReplies.length - 1];
    if (!newReply) return;

    const ticketId = event.params.ticketId;
    const userEmail = after.userEmail || "";
    const userId = after.userId;
    const isInternal = newReply.internal === true;
    const replyBody = String(newReply.message || "").slice(0, 100);
    const replyByUser = newReply.by && newReply.by === userEmail;
    const subject = (after.subject || "ticket").slice(0, 60);

    if (replyByUser) {
      // Mensaje del user → notificar admin.
      await db.collection("activity_events").add({
        kind: "support_user_reply",
        summary: `Respuesta del usuario en "${subject}"`,
        actor: userEmail || "anonymous",
        ticketId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const pushResult = await pushToAdminTopic(
        "Respondieron un ticket",
        `${userEmail}: ${replyBody}`,
        { type: "support_user_reply", ticketId }
      );

      await logPushEvent({
        type: "support_user_reply",
        ticketId,
        mechanisms: ["activity_event", pushResult.ok ? "fcm_topic" : "fcm_topic_failed"],
        status: pushResult.ok ? "sent" : "partial",
        error: pushResult.error || null,
      });
    } else if (!isInternal && userId) {
      // Mensaje del admin (público) → push FCM al user via user_tokens.
      const tokens = await fcmTokensFor([userId]);
      if (tokens.length === 0) {
        await logPushEvent({
          type: "support_admin_reply",
          ticketId,
          recipientUid: userId,
          mechanisms: ["fcm"],
          status: "skipped_no_token",
        });
        return;
      }
      const messaging = admin.messaging();
      const messages = tokens.map((token) => ({
        token,
        notification: {
          title: "Soporte te respondió",
          body: replyBody,
        },
        data: { type: "support_admin_reply", ticketId },
        apns: {
          payload: { aps: { "interruption-level": "active", sound: "default" } },
        },
        android: { priority: "high" },
      }));
      try {
        const response = await messaging.sendEach(messages);
        await logPushEvent({
          type: "support_admin_reply",
          ticketId,
          recipientUid: userId,
          mechanisms: ["fcm"],
          status: response.failureCount > 0 ? "partial" : "sent",
          successCount: response.successCount,
          failureCount: response.failureCount,
        });
      } catch (e) {
        await logPushEvent({
          type: "support_admin_reply",
          ticketId,
          recipientUid: userId,
          mechanisms: ["fcm"],
          status: "error",
          error: e.message,
        });
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Static GTFS pipeline (Milestone 2) — descarga ZIP, parsea, filtra por bbox,
// escribe snapshot.json (gzip) a Cloud Storage.
//
// Auth: enforced a nivel IAM Cloud Run invoker (no Firebase ID token). Solo
// principals con `roles/run.invoker` sobre el servicio pueden llamarla.
// Hoy: `domain:neodimio.com.uy` + service account del scheduler. Para llamar
// manualmente:
//   curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
//     "https://us-central1-vamo-dbad6.cloudfunctions.net/runStaticGtfsPipeline?feedId=..."
//
// Uso:
//   GET /runStaticGtfsPipeline?feedId=cm-lisboa-static&strongCascade=1
//
// Output:
//   gs://vamo-dbad6.firebasestorage.app/gtfs-snapshots/{feedId}/latest/snapshot.json.gz
//   gs://vamo-dbad6.firebasestorage.app/gtfs-snapshots/{feedId}/{YYYYMMDD}/snapshot.json.gz
//
// Función separada de `api` por dos razones:
//   1. Recursos pesados (memoria 2GiB para ZIPs ~100MB descomprimidos a ~600MB)
//   2. Timeout largo (540s — un fetch + parse de Lisboa puede tomar ~60-120s)
// ─────────────────────────────────────────────────────────────────────────────
exports.runStaticGtfsPipeline = onRequest(
  {
    region:         "us-central1",
    memory:         "16GiB",          // TransMilenio: 156MB zip → 1GB extracted + 500MB JSON + gzip buffers
    timeoutSeconds: 1800,             // bumpeado 2026-04-30: stopsByRoute parsea stop_times.txt entero (CABA: ~13M filas + ~2-3 min extra). Ceiling Gen2 = 3600s.
    cpu:            4,                // CPUs adicionales aceleran parse de stop_times grandes
    cors:           false,            // admin-only, no se llama desde browser cliente
    invoker:        "private",        // bloquea allUsers; IAM enforced al deployar
    secrets:        [baTransportClientId, baTransportClientSecret], // inyectados a feeds GCBA con `requiresAuth: "BA_TRANSPORT"`
  },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      return fail(res, "METHOD_NOT_ALLOWED");
    }

    // Si llegamos acá Cloud Run ya validó IAM invoker. Logueamos el caller
    // (extraído del header X-Goog-Authenticated-User-Email cuando IAP/IAM
    // lo provee, o del JWT Authorization Bearer cuando es OIDC directo).
    const callerEmail =
      req.headers["x-goog-authenticated-user-email"] ||
      req.headers["x-cloud-run-caller"] ||
      "iam-authenticated";
    logger.info(`runStaticGtfsPipeline caller: ${callerEmail}`);

    const feedId        = (req.query.feedId || "").toString();
    const strongCascade = req.query.strongCascade === "1" || req.query.strongCascade === "true";

    if (!feedId) {
      return fail(res, "INVALID_REQUEST", "Falta query param 'feedId'");
    }

    let feedConfig = staticFeeds.getStaticFeed(feedId);
    if (!feedConfig) {
      return fail(res, "INVALID_REQUEST", `feedId desconocido: ${feedId}`);
    }

    // Inyección de credenciales para feeds protegidos por la API gateway
    // de GCBA (`gcba-subte-static`, futuros `gcba-trenes-static`, etc.).
    // El feed config trae `requiresAuth: "BA_TRANSPORT"` y la sourceUrl
    // base; acá la mutamos para agregar `?client_id=X&client_secret=Y`
    // antes de pasarla al pipeline (que hace axios.get directo).
    if (feedConfig.requiresAuth === "BA_TRANSPORT") {
      // `.trim()` por si los secrets se crearon con un trailing newline (caso
      // típico al pegar valores con `gcloud secrets create --data-file=...`).
      // Sin trim, el `\n` se manda al upstream y el proxy GCBA rechaza con 401.
      const cid  = (baTransportClientId.value() || "").trim();
      const csec = (baTransportClientSecret.value() || "").trim();
      if (!cid || !csec) {
        logger.error(`runStaticGtfsPipeline ${feedId}: BA_TRANSPORT secrets no configurados`);
        return fail(res, "MISCONFIGURED", "BA_TRANSPORT credentials missing");
      }
      const sep = feedConfig.sourceUrl.includes("?") ? "&" : "?";
      // SIN `encodeURIComponent` — el proxy GCBA Mulesoft espera los valores
      // crudos (validado: el curl directo `?client_id=$CID&client_secret=$CSEC`
      // sin encode devuelve 200, mientras que con encode sobre algunos chars
      // base64 (`+`, `/`, `=`) el upstream rechaza con 401.
      // `fetchUrl` se usa solo para el axios.get del pipeline. `sourceUrl`
      // queda intacta para no exponer credenciales en meta.json / snapshot.json.
      feedConfig = {
        ...feedConfig,
        fetchUrl: `${feedConfig.sourceUrl}${sep}client_id=${cid}&client_secret=${csec}`,
      };
    }

    logger.info(`runStaticGtfsPipeline: ${feedId} arrancando (strongCascade=${strongCascade})`);

    try {
      const t0 = Date.now();

      // Custom builders: feeds que NO tienen GTFS-zip estándar y necesitan
      // un converter dedicado (ej CODESA MyMaps que es N KMLs separados).
      // El custom builder devuelve directamente el snapshot canónico sin
      // pasar por el pipeline genérico.
      let snapshot, durationMs;
      if (feedConfig.customBuilder) {
        const builderModule = require(`./lib/adapters/${feedConfig.customBuilder}`);
        snapshot = await builderModule.buildSnapshot({ feedConfig });
        durationMs = Date.now() - t0;
      } else {
        const r = await staticGtfsPipeline.runPipeline(feedConfig, { strongCascade });
        snapshot = r.snapshot;
        durationMs = r.durationMs;
      }
      logger.info(`runStaticGtfsPipeline: ${feedId} pipeline OK en ${durationMs}ms (stops=${snapshot.counts.stops}, routes=${snapshot.counts.routes}, trips=${snapshot.counts.trips}, shapes=${snapshot.counts.shapes})`);

      // Serializar + gzip (Cloud Storage acepta cualquier blob, gzip aliviana costo de transferencia)
      const json = JSON.stringify(snapshot);
      const gzipped = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
      const sizeMb = (gzipped.length / 1024 / 1024).toFixed(2);

      // Path con date EN LA TZ DE LA CIUDAD (no UTC). Si Lisboa procesa a
      // las 02:30 local del 29-abril (= 01:30 UTC del 29-abril), el snapshot
      // queda en `gtfs-snapshots/cm-lisboa-static/2026-04-29/...`. Para Mvd
      // procesado a 02:30 UY (= 05:30 UTC), también `2026-04-29`. Cada feed
      // tiene "su" día.
      const feedTz = require("./lib/feed-timezones");
      const local = feedTz.localTimeForFeed(feedId) || {
        dateLocal: new Date().toISOString().slice(0, 10),
        tz:        "UTC",
      };
      const dateLocal = local.dateLocal;             // "2026-04-29"
      const datePath  = dateLocal.replace(/-/g, ""); // "20260429"

      const bucket = admin.storage().bucket(); // bucket default vamo-dbad6.firebasestorage.app
      const latestPath = `gtfs-snapshots/${feedId}/latest/snapshot.json.gz`;
      const datedPath  = `gtfs-snapshots/${feedId}/${datePath}/snapshot.json.gz`;
      const metaPath   = `gtfs-snapshots/${feedId}/${datePath}/meta.json`;
      const latestMeta = `gtfs-snapshots/${feedId}/latest/meta.json`;

      const fetchedAtUtc = new Date().toISOString();
      const meta = {
        feedId,
        sourceUrl:         feedConfig.sourceUrl,
        license:           feedConfig.license,
        cityIds:           feedConfig.cityIds,
        cityTimezone:      local.tz,
        snapshotDateLocal: dateLocal,
        fetchedAtUtc,
        // ISO-8601 con offset de la TZ de la ciudad (legible para auditoría).
        fetchedAtLocal:    new Date(fetchedAtUtc).toLocaleString("sv-SE", {
          timeZone: local.tz, hour12: false,
        }).replace(" ", "T") + " (" + local.tz + ")",
        durationMs,
        snapshotSizeBytes: gzipped.length,
        counts:            snapshot.counts,
        strongCascade,
      };

      const writeOpts = {
        contentType:        "application/json",
        contentEncoding:    "gzip",
        cacheControl:       "public, max-age=3600",
        metadata: {
          feedId,
          strongCascade:     String(strongCascade),
          generatedAt:       snapshot.generatedAt,
          cityTimezone:      local.tz,
          snapshotDateLocal: dateLocal,
          counts:            JSON.stringify(snapshot.counts),
        },
      };
      const metaWriteOpts = {
        contentType:  "application/json",
        cacheControl: "public, max-age=300", // meta cambia cada noche, TTL corto
      };
      const metaJson = JSON.stringify(meta, null, 2);

      await bucket.file(latestPath).save(gzipped,           { metadata: writeOpts, resumable: false });
      await bucket.file(datedPath).save(gzipped,            { metadata: writeOpts, resumable: false });
      await bucket.file(metaPath).save(metaJson,            { metadata: metaWriteOpts, resumable: false });
      await bucket.file(latestMeta).save(metaJson,          { metadata: metaWriteOpts, resumable: false });

      // Hacer público el snapshot para que el cliente iOS los descargue
      // sin auth desde `https://storage.googleapis.com/<bucket>/<path>`. Los
      // datos GTFS son de origen público — no hay PII ni nada sensible.
      try {
        await bucket.file(latestPath).makePublic();
        await bucket.file(datedPath).makePublic();
        await bucket.file(metaPath).makePublic();
        await bucket.file(latestMeta).makePublic();
      } catch (e) {
        logger.warn(`runStaticGtfsPipeline ${feedId} makePublic warning: ${e.message}`);
      }

      const totalDurationMs = Date.now() - t0;
      logger.info(`runStaticGtfsPipeline: ${feedId} snapshot escrito (${sizeMb} MB gzip) en ${totalDurationMs}ms total`);

      return ok(res, {
        feedId,
        durationMs:    totalDurationMs,
        pipelineMs:    durationMs,
        snapshotSizeBytes: gzipped.length,
        counts:        snapshot.counts,
        paths: {
          latest: `gs://${bucket.name}/${latestPath}`,
          dated:  `gs://${bucket.name}/${datedPath}`,
        },
      });
    } catch (e) {
      logger.error(`runStaticGtfsPipeline ${feedId} error: ${e.message}`, { stack: e.stack });
      return fail(res, "PIPELINE_FAILED", e.message);
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// Pub/Sub consumer: writes fire-and-forget de /user/fcm-token, /activity/register
// Latencia user-facing baja de ~558ms (Firestore RTT cross-region) a ~50ms.
// El write a Firestore ocurre acá en background.
// ─────────────────────────────────────────────────────────────────
exports.onAsyncWrite = onMessagePublished(
  {
    topic:          "vamo-async-writes",
    memory:         "256MiB",
    timeoutSeconds: 30,
    retry:          true,            // Pub/Sub reintenta hasta 7 días por default
  },
  async (event) => {
    let msg;
    try {
      msg = event.data.message.json
        || JSON.parse(Buffer.from(event.data.message.data, "base64").toString());
    } catch (e) {
      logger.error(`onAsyncWrite parse error: ${e.message}`);
      return;
    }

    const { kind, payload } = msg || {};
    if (!kind || !payload) {
      logger.warn(`onAsyncWrite missing kind/payload: ${JSON.stringify(msg)}`);
      return;
    }

    try {
      switch (kind) {
        case "fcm-token": {
          const { userId, fcmToken } = payload;
          if (!userId || !fcmToken) return;
          await db.collection("user_tokens").doc(userId).set({
            fcmToken,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          break;
        }
        case "activity-register": {
          const { docId, pushToken, activityId, ownerUid } = payload;
          if (!docId || !pushToken || !ownerUid) return;
          await db.collection("live_activity_tokens").doc(docId).set({
            pushToken,
            activityId: activityId || "",
            ownerUid,
            registeredAt: admin.firestore.FieldValue.serverTimestamp(),
            active: true,
          }, { merge: true });
          break;
        }
        default:
          logger.warn(`onAsyncWrite unknown kind: ${kind}`);
      }
    } catch (e) {
      // Lanzar para que Pub/Sub reintente el delivery
      logger.error(`onAsyncWrite ${kind} error: ${e.message}`);
      throw e;
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// Track D — Nightly GTFS batch (orquestador)
// ─────────────────────────────────────────────────────────────────
//
// Diseño:
//   - Corre cada hora (UTC).
//   - Para cada feed estático en STATIC_FEEDS:
//       * Resuelve TZ de la ciudad (Mvd → America/Montevideo, Lisboa → Europe/Lisbon, etc.)
//       * Si hora local en [02:00, 03:59] → procesa este feed
//       * Idempotencia: chequea Firestore `gtfs_runs/{feedId}__{dateLocal}`
//         (donde dateLocal = "YYYY-MM-DD" en TZ de la ciudad). Si ya corrió, skip.
//   - Invoca `runStaticGtfsPipeline` (us-central1) via HTTP firmado.
//
// El orquestador vive en sa-east1 (default global region) pero el pipeline
// vive en us-central1 (depende del bucket us-central1). Cross-region call
// del orquestador al pipeline es OK: trivial overhead (~125ms una vez por feed/noche).
//
// Schedule: cada hora — la ventana es 2h (02:00-03:59 local), entonces hay 2
// chances de disparo. Idempotencia evita doble-corrida.

exports.nightlyGtfsBatch = onSchedule(
  {
    schedule:       "every 1 hours",
    timeZone:       "UTC",
    memory:         "256MiB",
    timeoutSeconds: 540,    // permite procesar varios feeds en serie con margen
  },
  async () => {
    const feedTz = require("./lib/feed-timezones");
    const feeds = staticFeeds.STATIC_FEEDS;

    logger.info(`nightlyGtfsBatch: evaluando ${feeds.length} feeds`);

    const now = new Date();
    let processed = 0, skipped = 0, failed = 0;

    for (const feed of feeds) {
      const feedId = feed.feedId;
      const local = feedTz.localTimeForFeed(feedId, now);

      if (!local) {
        logger.warn(`nightlyGtfsBatch: ${feedId} sin TZ resoluble — skip`);
        continue;
      }

      // Ventana 02:00-03:59 local
      const inWindow = local.hour >= 2 && local.hour < 4;
      if (!inWindow) {
        skipped += 1;
        continue;
      }

      // Idempotencia: ¿ya corrió hoy (dateLocal de la ciudad)?
      const runId = `${feedId}__${local.dateLocal}`;
      const runDocRef = db.collection("gtfs_runs").doc(runId);
      const runDoc = await runDocRef.get();
      if (runDoc.exists && runDoc.data().status === "ok") {
        logger.info(`nightlyGtfsBatch: ${feedId} ya procesado para ${local.dateLocal} (${local.tz}) — skip`);
        skipped += 1;
        continue;
      }

      // Marcar in-progress
      await runDocRef.set({
        feedId,
        cityTimezone: local.tz,
        dateLocal:    local.dateLocal,
        startedAtUtc: new Date().toISOString(),
        status:       "running",
      }, { merge: true });

      // Invocar pipeline en us-central1 con OIDC token (la function tiene
      // invoker:private, requiere IAM auth)
      const pipelineUrl = `https://runstaticgtfspipeline-uz7smrj4ua-uc.a.run.app?feedId=${encodeURIComponent(feedId)}`;
      try {
        const { GoogleAuth } = require("google-auth-library");
        const auth = new GoogleAuth();
        const client = await auth.getIdTokenClient(pipelineUrl);
        const tStart = Date.now();
        const r = await client.request({
          url:    pipelineUrl,
          method: "GET",
          timeout: 540_000,
        });
        const durationMs = Date.now() - tStart;

        if (r.data && r.data.ok) {
          await runDocRef.set({
            status:        "ok",
            finishedAtUtc: new Date().toISOString(),
            durationMs,
            counts:        r.data.data?.counts || null,
            sizeBytes:     r.data.data?.snapshotSizeBytes || null,
          }, { merge: true });
          processed += 1;
          logger.info(`nightlyGtfsBatch: ${feedId} OK en ${durationMs}ms (${local.dateLocal} ${local.tz})`);
        } else {
          throw new Error(`Pipeline returned non-ok: ${JSON.stringify(r.data).slice(0, 200)}`);
        }
      } catch (e) {
        await runDocRef.set({
          status:        "failed",
          finishedAtUtc: new Date().toISOString(),
          error:         (e.message || String(e)).slice(0, 500),
        }, { merge: true });
        failed += 1;
        logger.error(`nightlyGtfsBatch: ${feedId} FAILED — ${e.message}`);
      }
    }

    logger.info(`nightlyGtfsBatch: done — processed=${processed} skipped=${skipped} failed=${failed}`);
  }
);
