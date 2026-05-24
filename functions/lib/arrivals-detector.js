/**
 * Detector de arrivals/departures por proximidad bus↔parada.
 *
 * Algoritmo simple basado en transiciones snapshot-a-snapshot:
 *   - Para cada bus, calcular distancia a todas las paradas de SU LÍNEA.
 *   - Si distancia < ARRIVAL_RADIUS_M y bus NO estaba antes en esa parada:
 *     emit "arrived".
 *   - Si bus estaba en parada antes pero ahora no: emit "departed" con
 *     dwell time + min distance en la ventana.
 *
 * State entre snapshots:
 *   - Persistido en Redis L2 bajo key `vamo:telemetry:arrivals_state_v1`.
 *   - Shape: `{ buses: { [busId]: { [stopId]: { firstSeenTs, minDistM } } } }`.
 *   - Solo se guardan buses con ≥1 parada en radio (state tight).
 *   - TTL 5min — sobrevive entre ticks 1min sin problema. Si el cron
 *     muere y no escribe por 5 min, el state se pierde y la próxima
 *     ejecución arranca limpia (1 snapshot sin detecciones, después
 *     normal).
 *
 * Limitación V0:
 *   - Si un bus pasa por una parada entre dos snapshots (1 min) sin
 *     quedarse, el detector lo va a perder. La velocidad típica del bus
 *     urbano (15-25 km/h) y el radio de 50m dan ~7-12s en zona — menos
 *     que el tick. Probabilidad real: ~25% de eventos perdidos. Aceptable
 *     V0; si queremos cobertura total habría que subir resolución del
 *     cron o cambiar a interpolación trayectoria.
 *
 * Limitación V0:
 *   - Buses sin línea válida o con línea no presente en stopsByLine se
 *     omiten. Se loggea sample para diagnosticar.
 */

const { logger } = require("firebase-functions");
const redisCache = require("./redis-cache");
const { getStopsForLine } = require("./stops-catalog");
const { haversineMeters, buildArrivalEvent, publishBusArrival } = require("./telemetry");

const ARRIVAL_RADIUS_M = 50;
const PREFILTER_DEG = 0.001; // ~111m por grado de lat. Skip si |Δlat| > 0.001.
const STATE_NAMESPACE = "telemetry";
const STATE_KEY = "arrivals_state_v1";
const STATE_TTL_MS = 5 * 60 * 1000;
const MAX_LINE_MISS_LOG_PER_TICK = 5;

async function loadState() {
  const entry = await redisCache.getEntry(STATE_NAMESPACE, STATE_KEY);
  if (!entry || typeof entry.data !== "object") return { buses: {} };
  return entry.data;
}

function saveState(state) {
  redisCache.setEntry(
    STATE_NAMESPACE,
    STATE_KEY,
    {
      data: state,
      etag: null,
      expiry: Date.now() + STATE_TTL_MS,
      cachedAt: Date.now(),
      ttl: STATE_TTL_MS,
    },
    STATE_TTL_MS
  );
}

/**
 * Procesa un snapshot completo: emite arrivals/departures + actualiza state.
 *
 * @param {object} args
 * @param {Array<object>} args.buses - buses en formato canónico (mapImmStmBus output)
 * @param {Date} args.now
 * @param {object} [args.etaCtx]
 * @returns {Promise<{ arrivedCount, departedCount, processedBuses, skippedNoLine }>}
 */
async function processSnapshot({ buses, now, etaCtx }) {
  if (!Array.isArray(buses) || buses.length === 0) {
    return { arrivedCount: 0, departedCount: 0, processedBuses: 0, skippedNoLine: 0 };
  }

  const prev = await loadState();
  const prevBuses = prev.buses || {};
  const nextBuses = {};

  let arrivedCount = 0;
  let departedCount = 0;
  let processedBuses = 0;
  let skippedNoLine = 0;
  let lineMissLogged = 0;

  for (const bus of buses) {
    const coords = bus?.position;
    if (!coords || typeof coords.lat !== "number" || typeof coords.lng !== "number") {
      continue;
    }
    const busId = String(bus.id || bus.busId || "");
    if (!busId) continue;
    const line = bus.trip?.routeShortName || bus.trip?.routeId || bus.line || null;
    if (!line) {
      skippedNoLine++;
      continue;
    }

    const candidates = getStopsForLine(line);
    if (candidates.length === 0) {
      if (lineMissLogged < MAX_LINE_MISS_LOG_PER_TICK) {
        logger.debug(`arrivals: línea ${line} sin paradas en catalog (bus ${busId})`);
        lineMissLogged++;
      }
      continue;
    }

    processedBuses++;

    const prevForBus = prevBuses[busId] || {};
    const nowForBus = {};

    for (const stop of candidates) {
      if (Math.abs(stop.lat - coords.lat) > PREFILTER_DEG) continue;
      if (Math.abs(stop.lng - coords.lng) > PREFILTER_DEG) continue;
      const distM = haversineMeters(coords.lat, coords.lng, stop.lat, stop.lng);
      if (distM > ARRIVAL_RADIUS_M) continue;

      const existing = prevForBus[stop.stopId];
      if (existing) {
        nowForBus[stop.stopId] = {
          firstSeenTs: existing.firstSeenTs,
          minDistM: Math.min(existing.minDistM, distM),
        };
      } else {
        nowForBus[stop.stopId] = {
          firstSeenTs: now.getTime(),
          minDistM: distM,
        };
        publishBusArrival(
          buildArrivalEvent({
            now,
            bus,
            stop,
            eventType: "arrived",
            distM,
            etaCtx,
          })
        );
        arrivedCount++;
      }
    }

    for (const [stopId, windowState] of Object.entries(prevForBus)) {
      if (nowForBus[stopId]) continue;
      const stop = candidates.find((s) => s.stopId === stopId);
      if (!stop) continue;
      const distNow = haversineMeters(coords.lat, coords.lng, stop.lat, stop.lng);
      publishBusArrival(
        buildArrivalEvent({
          now,
          bus,
          stop,
          eventType: "departed",
          distM: distNow,
          windowState,
          etaCtx,
        })
      );
      departedCount++;
    }

    if (Object.keys(nowForBus).length > 0) {
      nextBuses[busId] = nowForBus;
    }
  }

  saveState({ buses: nextBuses });

  return { arrivedCount, departedCount, processedBuses, skippedNoLine };
}

module.exports = {
  processSnapshot,
  ARRIVAL_RADIUS_M,
};
