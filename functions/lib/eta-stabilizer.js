/**
 * Evita oscilaciones del ETA visible entre polls consecutivos.
 *
 * Port del actor iOS `ETAStabilizer`. En Swift es un actor con `entries`
 * por busId. Acá usamos un Map a nivel de módulo — vive en la memoria de
 * la instancia Cloud Function. Como el deployment usa `minInstances: 1`,
 * el state persiste 24/7 entre requests.
 *
 * **Problema que resuelve:** un bus estable a 4 min 25 seg puede aparecer
 * como "4 min" en un poll y "5 min" en el siguiente por un cambio mínimo
 * de 5-10 seg en la estimación raw. El usuario percibe el número como
 * inestable.
 *
 * **Algoritmo:** dentro de una ventana de 25s, si la ETA raw cambió menos
 * de 36 seg (0.6 min), devolvemos el valor entero anterior. Cambios más
 * grandes sí se propagan — el bus se está acercando o alejando real.
 *
 * **Key:** `${stopId}:${busId}`. Mismo bus físico visto desde dos paradas
 * distintas tiene historias independientes (la ETA hasta cada parada es
 * distinta y oscila independientemente).
 *
 * **Multi-instancia:** Cloud Run puede levantar instancias adicionales
 * bajo carga. Cada una tiene su propio Map → un cliente que pega a
 * instancia A y después a B verá un valor sin histéresis en B. Aceptable:
 * la próxima poll en B ya tendrá historia. El cache compartido por
 * (stopId,line) TTL 5s del handler mitiga la mayor parte del problema
 * porque la mayoría de polls hit la misma instancia.
 */

/** Ventana de histéresis. Después de esto, arranca fresco sin memoria. */
const STICKY_WINDOW_MS = 25_000;

/** Delta mínimo en minutos para permitir cambio del valor visible. */
const STICKY_DELTA_MIN = 0.6;

/** Cuánto tiempo guardamos una entry sin actualizar antes de pruning. */
const PRUNE_AGE_MS = 600_000; // 10 min

/** Cada cuánto correr la pasada de prune (lazy, dentro de stabilize). */
const PRUNE_INTERVAL_MS = 60_000; // 1 min

const entries = new Map(); // key → { minutes, rawMinutes, at }
let lastPruneAt = 0;

/**
 * Estabiliza la ETA en minutos enteros.
 *
 * @param {string} key — único por bus físico y parada destino, ej "1234:567"
 * @param {number} etaFinalSec — ETA en segundos ya fusionado
 * @param {Date} now
 * @returns {number} minutos enteros a mostrar (>= 1)
 */
function stabilize({ key, etaFinalSec, now = new Date() }) {
  maybePrune(now);

  const rawMinutes = etaFinalSec / 60;
  const rounded = Math.max(1, Math.round(rawMinutes));
  const nowMs = now.getTime();

  const previous = entries.get(key);
  if (previous && nowMs - previous.at < STICKY_WINDOW_MS) {
    const delta = Math.abs(rawMinutes - previous.rawMinutes);
    if (delta < STICKY_DELTA_MIN) {
      // Oscilación chica → mantener valor previo, actualizar timestamp +
      // rawMinutes para que la próxima comparación use el dato fresco
      entries.set(key, {
        minutes: previous.minutes,
        rawMinutes,
        at: nowMs,
      });
      return previous.minutes;
    }
  }

  entries.set(key, { minutes: rounded, rawMinutes, at: nowMs });
  return rounded;
}

/**
 * Limpieza lazy de entries viejas. Llamado desde stabilize cada
 * PRUNE_INTERVAL_MS aprox. Evita leaks en instancias warm 24/7.
 */
function maybePrune(now) {
  const nowMs = now.getTime();
  if (nowMs - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = nowMs;

  let removed = 0;
  for (const [k, v] of entries) {
    if (nowMs - v.at > PRUNE_AGE_MS) {
      entries.delete(k);
      removed++;
    }
  }
  // Sin logging acá — corre dentro del hot path del handler.
  return removed;
}

/** Stats útiles para `/admin/diagnostics` o tests. */
function stats() {
  return {
    size: entries.size,
    lastPruneAt: lastPruneAt > 0 ? new Date(lastPruneAt).toISOString() : null,
  };
}

/** Reset completo (tests). */
function reset() {
  entries.clear();
  lastPruneAt = 0;
}

module.exports = {
  STICKY_WINDOW_MS,
  STICKY_DELTA_MIN,
  stabilize,
  stats,
  reset,
};
