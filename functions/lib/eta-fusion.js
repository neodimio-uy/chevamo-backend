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
const positionFuser = require("./position-fuser");
const sourceConfidence = require("./source-confidence");
const clusterer = require("./community-clusterer");

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
 * Busca un cluster comunitario que matchee con este bus IMM. Devuelve
 * `{ cluster, fused }` cuando hay match + fusion exitosa, sino null.
 *
 * **No recalcula el ETA**. Mirror del comportamiento de iOS en
 * `officialWithConfirmations` (FallbackETACalculator.swift:271-287): cuando
 * hay match, se respeta el `etaRaw` IMM y solo se enriquece con
 * `communityConfirmations`. La posición fusionada va al mapa, no al ETA.
 */
function matchCluster({ bus, clustersByLine, immAgeSec, now }) {
  if (!clustersByLine || typeof clustersByLine.get !== "function") return null;
  const line = (bus.line || "").trim();
  if (!line) return null;
  const candidates = clustersByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  const coords = bus?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [busLng, busLat] = coords;
  if (!Number.isFinite(busLat) || !Number.isFinite(busLng)) return null;

  for (const c of candidates) {
    const rep = c.representative;
    if (!rep) continue;
    // Match estricto por linea + lineVariantId + radio CommunityMatchConfig
    if (!positionFuser.sameVehicle({
      immLine: line,
      immVariantId: bus.lineVariantId,
      immCoord: { lat: busLat, lng: busLng },
      clusterLine: rep.line,
      clusterVariantId: rep.lineVariantId,
      clusterCoord: { lat: rep.lat, lng: rep.lng },
    })) continue;

    const comAge = clusterer.ageSeconds(rep.updatedAt, now.getTime());
    const immConf = sourceConfidence.forIMM({
      ageSeconds: immAgeSec,
      isZombie: false,
      speedKmh: typeof bus.speed === "number" ? bus.speed * 3.6 : null,
    });
    const comConf = sourceConfidence.forCommunity({
      ageSeconds: comAge,
      reporterCount: c.reporterCount,
      speedKmh: typeof rep.speed === "number" ? rep.speed * 3.6 : null,
    });
    const fused = positionFuser.fuse({
      immCoord: { lat: busLat, lng: busLng },
      immAge: immAgeSec,
      immConfidence: immConf,
      comCoord: { lat: rep.lat, lng: rep.lng },
      comAge,
      comConfidence: comConf,
    });
    return { cluster: c, fused, immConf, comConf, comAge };
  }
  return null;
}

/**
 * Fusiona un único bus. Async porque consulta calibrator lookup
 * (con cache). Devuelve el bus + campos nuevos.
 *
 * Si `compareMode` es true, agrega `_etaTelemetry` con el breakdown del
 * cálculo. Útil para `?compare=1` y BigQuery logging.
 *
 * **Sprint 0+1**: Si `clustersByLine` viene poblado y hay cluster matching,
 * se enriquece el bus con:
 *   - `communityConfirmations`: cluster.reporterCount
 *   - `etaSource`: "imm+community" (o "imm+google+community" si traffic aplicó)
 *   - Si la fusion fue exitosa, `location.coordinates` se mueve a la
 *     posición fusionada (mejor render en mapa). El ETA NO se recalcula —
 *     se respeta el ETA IMM como hace iOS en officialWithConfirmations.
 */
async function fuseBus({ bus, stopId, now, admin, compareMode = false, clustersByLine, immAgeSec = 30 }) {
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

  // Match comunidad (no toca baseEtaSec, solo enriquece)
  const communityMatch = baseSource === "imm"
    ? matchCluster({ bus, clustersByLine, immAgeSec, now })
    : null;

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

  // Etiqueta de fuente final. Si traffic se aplicó, lo señalamos. Si hay
  // match comunidad, sumamos el sufijo "+community".
  let etaSource = baseSource;
  if (trafficApplied) etaSource = `${baseSource}+google-traffic`;
  if (communityMatch) etaSource = `${etaSource}+community`;

  // Confidence (incluye boost por comunidad cuando hay match)
  let etaConfidence = computeConfidence({ bus, etaSource: baseSource, trafficApplied, calibSource });
  if (communityMatch) {
    // +0.1 por reporters extras pero cap a 1.0 (mismo patrón que iOS).
    const reporterBonus = Math.min(0.15, communityMatch.cluster.reporterCount * 0.05);
    etaConfidence = Math.min(1.0, Number((etaConfidence + reporterBonus).toFixed(3)));
  }

  // Si la fusion comunidad movió la posición, actualizamos location.coordinates
  // para que el marker en el mapa se vea en el lugar correcto. NO tocamos
  // ETA — eso queda como vino de IMM (mismo comportamiento iOS).
  let locationOverride = null;
  if (communityMatch?.fused?.coordinate) {
    const { lat, lng } = communityMatch.fused.coordinate;
    locationOverride = {
      ...bus.location,
      coordinates: [lng, lat],
    };
  }

  const result = {
    ...bus,
    ...(locationOverride && { location: locationOverride }),
    // Devolvemos segundos: el cliente convierte a minutos si necesita
    // (consistente con `etaRaw` y `googleEtaSec`). El stabilizer ya redondeó
    // a minutos enteros, por eso multiplicamos × 60 antes de exponer.
    etaFinalSec: etaFinalMin * 60,
    etaSource,
    etaConfidence,
    // Sprint 0+1: enriquecimiento comunidad (mirror de iOS).
    ...(communityMatch && {
      communityConfirmations: communityMatch.cluster.reporterCount,
      // Id del cluster matched — útil para el handler (skip al construir
      // buses puros) y para el cliente (correlación con listener Firestore
      // local). Es el id del doc representative del cluster.
      communityClusterId: communityMatch.cluster.representative?.id || null,
    }),
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
      community: communityMatch ? {
        matched: true,
        reporterCount: communityMatch.cluster.reporterCount,
        immConf: Number(communityMatch.immConf.toFixed(3)),
        comConf: Number(communityMatch.comConf.toFixed(3)),
        comAgeSec: Math.round(communityMatch.comAge),
        weightIMM: communityMatch.fused ? Number(communityMatch.fused.weightIMM.toFixed(3)) : null,
        weightCommunity: communityMatch.fused ? Number(communityMatch.fused.weightCommunity.toFixed(3)) : null,
        fusedCoord: communityMatch.fused?.coordinate || null,
      } : { matched: false },
    };
  }

  return result;
}

/**
 * Fusiona un array de UpcomingBus. Orquesta el async lookup del calibrator
 * (cacheado, así que típicamente sin IO real) y delega cada bus a `fuseBus`.
 */
async function fuseBuses({
  buses,
  stopId,
  now = new Date(),
  admin,
  compareMode = false,
  clustersByLine,
  immAgeSec = 30,
}) {
  if (!Array.isArray(buses) || buses.length === 0) return [];
  // Pre-cargar buckets de calibration (single IO + cache TTL 5min).
  await calibrator.factor({
    bucket: { line: "_warm_", hourBand: 0, dayKind: "wd" },
    admin,
  });
  return Promise.all(
    buses.map((bus) => fuseBus({ bus, stopId, now, admin, compareMode, clustersByLine, immAgeSec })),
  );
}

/**
 * Construye buses comunitarios PUROS — clusters que NO matchearon ningún
 * bus IMM, para líneas que paran en `stopLines`. Cada uno se modela como
 * `UpcomingBus` con `etaFinalSec` calculado desde haversine × 1.4 ÷ speed.
 *
 * Port del bucle iOS `FallbackETACalculator.swift:289-349`.
 *
 * Filtros (mirror iOS):
 *   - Cluster no stale (age < 90s — ya lo garantiza community-cache, pero
 *     re-chequeamos por defensa)
 *   - Línea pertenece al `stopLines` de la parada actual
 *   - Cluster no fue matched a un bus IMM (`matchedClusterIds`)
 *   - Distancia haversine ≥ 100m y < 3000m
 *   - ETA computado < 1800s (30 min) — sino descarta
 *
 * @param {object} opts
 *   - clustersByLine: Map<line, Cluster[]> de community-cache
 *   - stopLines: Array<string> líneas que paran en esta parada
 *   - stopCoord: { lat, lng }
 *   - matchedClusterIds: Set<string> ya consumidos por fuseBus
 *   - now: Date
 *   - admin: para calibrator lookup
 *   - compareMode: bool
 * @returns {Promise<UpcomingBus[]>}
 */
async function buildPureCommunityBuses({
  clustersByLine,
  stopLines = [],
  stopCoord,
  matchedClusterIds = new Set(),
  now = new Date(),
  admin,
  compareMode = false,
}) {
  if (!clustersByLine || !stopCoord) return [];
  if (!stopLines || stopLines.length === 0) return [];
  const stopLinesSet = new Set(stopLines.map((l) => String(l).trim()));

  const results = [];
  for (const [line, clusters] of clustersByLine) {
    if (!stopLinesSet.has(line)) continue;
    for (const cluster of clusters) {
      const rep = cluster.representative;
      if (!rep) continue;
      if (matchedClusterIds.has(rep.id)) continue;
      const comAge = clusterer.ageSeconds(rep.updatedAt, now.getTime());
      if (comAge > 90) continue;

      const straightDist = positionFuser.haversineMeters(
        { lat: rep.lat, lng: rep.lng },
        stopCoord,
      );
      const distMeters = straightDist * 1.4;
      if (distMeters < 100 || distMeters >= 3000) continue;

      // Velocidad efectiva (iOS pattern): bajo 5 m/s usar promedio con 4.2,
      // sino max(speed, 3).
      const speedMs = typeof rep.speed === "number" ? rep.speed : 0;
      const effectiveMs = speedMs < 5 ? (speedMs + 4.2) / 2 : Math.max(speedMs, 3);
      const baseEta = distMeters / effectiveMs;

      // Calibration bucket cascada (mismo bucket que fuseBus)
      const bucket = {
        line,
        hourBand: ctx.hourToBand(ctx.uyHour(now)),
        dayKind: ctx.dayKind(now),
        rainIntensity: "none",
        incidentSeverity: "none",
      };
      const { factor: calibFactor, source: calibSource } = await calibrator.factor({ bucket, admin });

      const etaSec = ctx.apply({
        baseEtaSec: baseEta,
        intermediateStops: 0,
        date: now,
        rainIntensity: "none",
        calibrationFactor: calibFactor,
      });
      const cappedEtaSec = Math.max(etaSec, 60);
      if (cappedEtaSec >= 1800) continue;

      // Stabilizer (clave única por cluster id + parada)
      const stabKey = `${stopCoord.lat.toFixed(4)},${stopCoord.lng.toFixed(4)}:cluster:${rep.id}`;
      const etaFinalMin = stabilizer.stabilize({ key: stabKey, etaFinalSec: cappedEtaSec, now });

      const bus = {
        // Schema compatible con UpcomingBus iOS — campos requeridos solo
        // los que iOS lee. `eta: 0` indica "sin ETA IMM oficial" — la app
        // hoy chequea `position < 0` o `position === 0` para identificar
        // buses no-IMM. Acá `position: -1` ⇒ "comunidad pura" (DataOrigin.community).
        busId: `community:${rep.id}`,
        line,
        companyName: rep.company || "",
        origin: rep.origin || null,
        destination: rep.destination || null,
        subline: null,
        special: false,
        eta: 0,
        distance: Math.round(distMeters),
        position: -1, // negative = community
        access: null,
        thermalConfort: null,
        emissions: null,
        location: {
          type: "Point",
          coordinates: [rep.lng, rep.lat],
        },
        lineVariantId: rep.lineVariantId,
        // Sprint 0+1 campos nuevos
        etaFinalSec: etaFinalMin * 60,
        etaSource: "community",
        etaConfidence: Math.min(0.9, 0.4 + cluster.reporterCount * 0.1),
        communityConfirmations: cluster.reporterCount,
        communityClusterId: rep.id,
      };
      if (compareMode) {
        bus._etaTelemetry = {
          baseSource: "community",
          straightDistM: Math.round(straightDist),
          distMetersAdjusted: Math.round(distMeters),
          speedMs: Number(speedMs.toFixed(2)),
          effectiveMs: Number(effectiveMs.toFixed(2)),
          baseEtaSec: Math.round(baseEta),
          calibFactor,
          calibSource,
          cappedEtaSec: Math.round(cappedEtaSec),
          stabilizedMinutes: etaFinalMin,
          reporterCount: cluster.reporterCount,
          comAgeSec: Math.round(comAge),
        };
      }
      results.push(bus);
    }
  }
  return results;
}

module.exports = {
  MIN_ETA_SEC,
  TRAFFIC_FACTOR_BOUNDS,
  TRAFFIC_DELTA_THRESHOLD_SEC,
  pickBase,
  computeTrafficFactor,
  computeConfidence,
  matchCluster,
  fuseBus,
  fuseBuses,
  buildPureCommunityBuses,
};
