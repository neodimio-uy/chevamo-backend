/**
 * Sonda sintética de ETA — Smart ETA v2 (ver chevamo-docs/eta/).
 *
 * **Por qué existe:** la medición de fiabilidad del ETA servido depende de filas
 * en `eta_requests`, que solo se generan cuando un usuario abre una parada en la
 * app. Pre-launch eso es ~0 → la medición antes/después está bloqueada. Esta
 * sonda llama `/upcoming` periódicamente sobre una muestra de paradas, generando
 * predicciones reales (servidas) que luego se validan automáticamente contra
 * `bus_arrivals` (mismo método que `measure-eta-reliability.sh`). Doble uso:
 * destraba la medición pre-launch Y queda de monitoreo continuo post-launch.
 *
 * **Diseño:**
 *   - Pega al URL DIRECTO de Cloud Run (no al dominio público), para saltear el
 *     Cloud CDN — sino la respuesta de `/upcoming` se serviría del edge sin
 *     invocar la función y NO se loggearía `eta_requests`.
 *   - **NO manda `stopLat/stopLng`**: con coords el handler llama Google Distance
 *     Matrix por bus (facturable) — miles de elementos/día con la sonda. Y como
 *     el `trafficFactor` está gateado OFF en prod, las coords NO cambian el ETA
 *     servido de los buses IMM (solo agregan `googleEtaSec`). Sin coords → costo
 *     Google CERO y medimos exactamente el ETA servido (IMM × multipliers × calib).
 *   - Solo corre en horario de servicio (6-23 hora Uruguay).
 *   - Fire-and-forget: no nos importa la respuesta, solo que el server registre
 *     la predicción. Errores se cuentan, no se propagan.
 */

const axios = require("axios");
const { logger } = require("firebase-functions");

// URL directo de Cloud Run (saltea CDN). Override por env si cambia la revisión.
const SELF_BASE = process.env.ETA_PROBE_BASE || "https://api-uz7smrj4ua-rj.a.run.app";
const SAMPLE_SIZE = Number(process.env.ETA_PROBE_SAMPLE || 20);
// Las llamadas se hacen SECUENCIALES con esta pausa entre cada una. Medido:
// una ráfaga de ~12 /upcoming seguidas devuelve 502 (estrés api/IMM). Secuencial
// + ~600ms espacia 20 llamadas en ~15-20s y no estresa el upstream IMM.
const THROTTLE_MS = Number(process.env.ETA_PROBE_THROTTLE_MS || 600);
const SERVICE_START_UY = 6;
const SERVICE_END_UY = 23;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hora de Uruguay (UTC-3, sin DST desde 2015). */
function uyHour(now) {
  return (now.getUTCHours() + 24 - 3) % 24;
}

/** Muestra simple de k elementos sin reemplazo (Fisher-Yates parcial). */
function sampleK(arr, k) {
  const a = arr.slice();
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor((a.length - i) * pseudoRandom(i, a.length));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// PRNG determinístico por corrida (Math.random no está disponible en algunos
// contextos restringidos; igual no necesitamos azar criptográfico, solo rotar
// la muestra). Mezcla índice + tamaño + minuto actual.
let _seed = 0;
function pseudoRandom(i, n) {
  _seed = (_seed * 1103515245 + 12345 + i * 7 + n) & 0x7fffffff;
  return _seed / 0x7fffffff;
}

async function runProbe({ now = new Date(), sampleSize = SAMPLE_SIZE } = {}) {
  const h = uyHour(now);
  if (h < SERVICE_START_UY || h >= SERVICE_END_UY) {
    return { skipped: `fuera de horario de servicio (${h}h UY)` };
  }
  _seed = (now.getUTCMinutes() + 1) * 2654435761 & 0x7fffffff;

  // 1) Catálogo de paradas (con coords). Vía run.app directo.
  let stops;
  try {
    const { data } = await axios.get(`${SELF_BASE}/busstops`, { timeout: 15000 });
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    stops = list.filter((s) => Array.isArray(s?.location?.coordinates) && s.location.coordinates.length === 2);
  } catch (e) {
    logger.warn(`probeEtaSamples: no se pudo cargar /busstops: ${e.message}`);
    return { ok: false, error: "busstops fetch failed" };
  }
  if (!stops.length) return { skipped: "catálogo de paradas vacío" };

  const picked = sampleK(stops, sampleSize);
  let ok = 0;
  let err = 0;
  // SECUENCIAL con throttle (no Promise.all): una ráfaga concurrente devuelve
  // 502 (estrés api/IMM). Espaciar protege el upstream IMM y a usuarios reales.
  for (const s of picked) {
    const id = s.busstopId ?? s.id ?? s.stopId;
    const [lng, lat] = s.location.coordinates;
    if (id == null || !Number.isFinite(lat) || !Number.isFinite(lng)) { err++; continue; }
    try {
      // Sin stopLat/stopLng a propósito: evita el costo de Google Distance
      // Matrix. El ETA servido de los buses IMM no depende de coords (traffic
      // gateado OFF). amount=3 buses/línea como la app.
      await axios.get(`${SELF_BASE}/busstops/${id}/upcoming`, {
        params: { amount: 3 },
        timeout: 12000,
      });
      ok++;
    } catch (e) {
      err++;
    }
    await sleep(THROTTLE_MS);
  }
  logger.info(`probeEtaSamples: ${ok} paradas sondeadas (${err} errores) de ${picked.length} · ${h}h UY`);
  return { ok: true, probed: ok, errors: err, sampled: picked.length };
}

module.exports = { runProbe, uyHour, sampleK, SAMPLE_SIZE };
