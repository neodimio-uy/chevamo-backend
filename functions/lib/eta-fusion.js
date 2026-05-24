/**
 * Orquestador server-side de ETA.
 *
 * Toma los UpcomingBus crudos del IMM (+ enriquecimiento opcional Google
 * Distance Matrix) y devuelve los mismos buses enriquecidos con
 * `etaFinal`, `etaSource` y `etaConfidence`.
 *
 * **Pipeline por bus:**
 *   1. Determinar `baseEtaSec` y `etaSource` (IMM primario, Google fallback)
 *   2. Calcular `trafficFactor` (delta Google vs IMM como proxy de
 *      weather + tráfico real + eventos)
 *   3. Aplicar `hour × day × weather × trafficFactor × calibration`
 *      (ETAContext)
 *   4. Stabilize: histéresis 25s/0.6min por (stopId, busId)
 *   5. Compute `etaConfidence` 0-1 según fuentes disponibles
 *
 * **No-comunidad por ahora.** Sprint 0 deja la comunidad en iOS — el
 * server no la lee. Sprint 0+1 incorpora cron `community_buses → memory`
 * y agrega community fusion al pipeline.
 *
 * **No-fallback GPS por ahora.** Si IMM no reporta y Google tampoco,
 * devolvemos `etaFinal: null` y `etaSource: "none"`. iOS sigue calculando
 * con `FallbackETACalculator` local. Sprint 0+1 lo trae al server.
 *
 * **Pureza:** todas las funciones excepto `fuseBuses` son puras (mismo
 * input → mismo output). `fuseBuses` usa el stabilizer (Map global) y
 * el calibrator lookup (cache + Firestore IO). Aceptan inyección de
 * dependencias para tests.
 */

const ctx = require("./eta-context");
const stabilizer = require("./eta-stabilizer");
const calibrator = require("./eta-calibrator-lookup");

/** Cota inferior absoluta del etaFinal — buses dentro del minuto siguiente
 *  igual se reportan como "1 min" (Math.max(1, …) en el stabilizer). */
const MIN_ETA_SEC = 30;

/** Cota superior del trafficFactor para evitar runaway por outliers. */
const TRAFFIC_FACTOR_BOUNDS = [0.5, 2.0];

/** Umbral para considerar "tráfico anormal" (delta Google vs IMM). */
const TRAFFIC_DELTA_THRESHOLD_SEC = 60;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Decide la ETA base y la fuente.
 * Preferencia: IMM `eta` (segundos del schema UpcomingBusSchema) >
 * Google `googleEtaSec` > null. (iOS mappea `eta` → `etaRaw` via CodingKeys,
 * pero en el JSON del wire el campo se llama `eta`.)
 *
 * **Por qué IMM > Google:** IMM es el dato oficial del operador, está
 * calibrado contra la observación real del bus. Google es ETA modelado
 * por tráfico. En condiciones normales son razonables. En condiciones
 * anormales (lluvia, incidente) Google reacciona más rápido — capturamos
 * eso vía `trafficFactor` aplicado a la base IMM, no reemplazando.
 */
function pickBase(bus) {
  if (typeof bus.eta === "number" && bus.eta > 0) {
    return { baseEtaSec: bus.eta, source: "imm" };
  }
  if (typeof bus.googleEtaSec === "number" && bus.googleEtaSec > 0) {
    return { baseEtaSec: bus.googleEtaSec, source: "google" };
  }
  return { baseEtaSec: null, source: "none" };
}

/**
 * Computa el `trafficFactor`. Solo lo aplica cuando ambos están disponibles
 * y el delta es significativo (>60s). Si Google dice MÁS, hay tráfico /
 * lluvia → factor >1. Si dice MENOS, condiciones óptimas → factor <1.
 */
function computeTrafficFactor(bus) {
  if (typeof bus.eta !== "number" || typeof bus.googleEtaSec !== "number") {
    return { factor: 1.0, applied: false };
  }
  if (bus.eta <= 0 || bus.googleEtaSec <= 0) {
    return { factor: 1.0, applied: false };
  }
  const delta = Math.abs(bus.googleEtaSec - bus.eta);
  if (delta < TRAFFIC_DELTA_THRESHOLD_SEC) {
    return { factor: 1.0, applied: false };
  }
  const raw = bus.googleEtaSec / Math.max(bus.eta, 60);
  const factor = clamp(raw, TRAFFIC_FACTOR_BOUNDS[0], TRAFFIC_FACTOR_BOUNDS[1]);
  return { factor, applied: true };
}

/**
 * Confidence 0-1. Suma puntos por cada señal independiente disponible.
 *   - IMM presente: +0.5 (base)
 *   - Google presente + concuerda con IMM (delta <60s): +0.3
 *   - Google presente + diverge: +0.15 (tenemos más info, pero conflictiva)
 *   - Calibración con bucket exact/parent: +0.2
 *   - Calibración con grandpa o sin calibración: +0.05
 *
 * Cap a 1.0. Si baseEtaSec es null, confidence siempre 0.
 */
function computeConfidence({ bus, etaSource, trafficApplied, calibSource }) {
  if (etaSource === "none") return 0;
  let conf = 0;
  if (etaSource === "imm") conf += 0.5;
  else if (etaSource === "google") conf += 0.35;

  if (typeof bus.googleEtaSec === "number" && typeof bus.eta === "number") {
    const delta = Math.abs(bus.googleEtaSec - bus.eta);
    conf += delta < TRAFFIC_DELTA_THRESHOLD_SEC ? 0.3 : 0.15;
  }

  if (calibSource === "exact" || calibSource === "parent") conf += 0.2;
  else conf += 0.05;

  return Math.min(1.0, Number(conf.toFixed(3)));
}

/**
 * Fusiona un único bus. Async porque consulta calibrator lookup
 * (con cache). Devuelve el bus + campos nuevos.
 *
 * Si `compareMode` es true, agrega `_etaTelemetry` con el breakdown del
 * cálculo. Útil para `?compare=1` y BigQuery logging. NO se envía al
 * cliente en modo normal.
 */
async function fuseBus({ bus, stopId, now, admin, compareMode = false }) {
  const { baseEtaSec, source: baseSource } = pickBase(bus);

  if (baseEtaSec == null) {
    return {
      ...bus,
      etaFinalSec: null,
      etaSource: "none",
      etaConfidence: 0,
      ...(compareMode && {
        _etaTelemetry: { reason: "no-base-eta" },
      }),
    };
  }

  // Multipliers contextuales
  const hourMul = ctx.hourMultiplier(now);
  const dayMul = ctx.weekdayMultiplier(now);
  const weatherMul = ctx.weatherMultiplier("none"); // Sprint 0+1 traerá rain real

  // Traffic factor (proxy weather + tráfico + eventos vía Google)
  const { factor: trafficFactor, applied: trafficApplied } = computeTrafficFactor(bus);

  // Calibration bucket cascada
  const bucket = {
    line: (bus.line || "").trim(),
    hourBand: ctx.hourToBand(ctx.uyHour(now)),
    dayKind: ctx.dayKind(now),
    rainIntensity: "none",
    incidentSeverity: "none",
  };
  const { factor: calibFactor, source: calibSource } = bucket.line
    ? await calibrator.factor({ bucket, admin })
    : { factor: 1.0, source: "none" };

  // Smart ETA: NO incluimos intermediateStops (requiere shape match que el
  // cliente tiene mejor) — el server aplica solo los multipliers globales.
  const multiplier = hourMul * dayMul * weatherMul * trafficFactor * calibFactor;
  let etaFinalSec = baseEtaSec * multiplier;
  etaFinalSec = Math.max(MIN_ETA_SEC, etaFinalSec);

  // Stabilizer: por (stopId, busId). Devuelve minutos enteros.
  const busId = bus.busId || bus.id || bus.code || `${bus.line}:${bus.position || ""}`;
  const stabKey = `${stopId}:${busId}`;
  const etaFinalMin = stabilizer.stabilize({ key: stabKey, etaFinalSec, now });

  // Etiqueta de fuente final. Si traffic se aplicó, lo señalamos.
  let etaSource = baseSource;
  if (trafficApplied) etaSource = `${baseSource}+google-traffic`;

  // Confidence
  const etaConfidence = computeConfidence({ bus, etaSource: baseSource, trafficApplied, calibSource });

  const result = {
    ...bus,
    // Devolvemos segundos: el cliente convierte a minutos si necesita
    // (consistente con `etaRaw` y `googleEtaSec`). El stabilizer ya redondeó
    // a minutos enteros, por eso multiplicamos × 60 antes de exponer.
    etaFinalSec: etaFinalMin * 60,
    etaSource,
    etaConfidence,
  };

  if (compareMode) {
    result._etaTelemetry = {
      baseEtaSec,
      baseSource,
      hourMul,
      dayMul,
      weatherMul,
      trafficFactor,
      trafficApplied,
      calibFactor,
      calibSource,
      bucket,
      preStabilizeSec: Math.round(etaFinalSec),
      stabilizedMinutes: etaFinalMin,
    };
  }

  return result;
}

/**
 * Fusiona un array de UpcomingBus. Orquesta el async lookup del calibrator
 * (cacheado, así que típicamente sin IO real) y delega cada bus a `fuseBus`.
 */
async function fuseBuses({ buses, stopId, now = new Date(), admin, compareMode = false }) {
  if (!Array.isArray(buses) || buses.length === 0) return [];
  // Pre-cargar buckets de calibration (single IO + cache TTL 5min).
  await calibrator.factor({
    bucket: { line: "_warm_", hourBand: 0, dayKind: "wd" },
    admin,
  });
  return Promise.all(buses.map((bus) => fuseBus({ bus, stopId, now, admin, compareMode })));
}

module.exports = {
  MIN_ETA_SEC,
  TRAFFIC_FACTOR_BOUNDS,
  TRAFFIC_DELTA_THRESHOLD_SEC,
  pickBase,
  computeTrafficFactor,
  computeConfidence,
  fuseBus,
  fuseBuses,
};
