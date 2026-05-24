/**
 * Score de confianza de una fuente de posición de bus.
 *
 * Port directo de iOS `Vamo/Models/SourceConfidence.swift`. La regla v1.0
 * es que IMM y Comunidad son fuentes complementarias del mismo nivel
 * conceptual — el algoritmo de fusión decide cuánto pesa cada una por su
 * `confidence × freshness`, no por su origen.
 *
 * **Rango:** 0.0 (fuente no confiable, ignorar) a 1.0 (fuente perfecta).
 * En la práctica los scores se mueven entre 0.3 y 0.9.
 *
 * Funciones puras — testeables y determinísticas.
 */

/**
 * Freshness gradient simétrico. Reemplaza el corte duro a 90s con curva
 * continua aplicada igual a IMM y Comunidad.
 *
 * Bandas:
 *   0-15s   → 1.0 (full authority)
 *   15-30s  → 1.0 → 0.4 lineal
 *   30-60s  → 0.4 → 0.1 lineal
 *   60-90s  → 0.1 → 0.0 lineal
 *   90s+    → 0.0 (ignorar)
 */
function freshnessScore(ageSeconds) {
  const age = Math.max(0, ageSeconds);
  if (age <= 15) return 1.0;
  if (age >= 90) return 0.0;
  if (age <= 30) return 1.0 - ((age - 15) / 15) * 0.6;
  if (age <= 60) return 0.4 - ((age - 30) / 30) * 0.3;
  return 0.1 - ((age - 60) / 30) * 0.1;
}

/**
 * Score final para un sample de IMM.
 *
 * @param {object} opts
 *   - ageSeconds: segundos desde el last position report del bus
 *   - isZombie: el server detectó bus sin movimiento >5min (siempre 0)
 *   - speedKmh: velocidad reportada (cap físico, >80 urbano es sospechoso)
 */
function forIMM({ ageSeconds, isZombie = false, speedKmh = null }) {
  if (isZombie) return 0.0;
  let score = freshnessScore(ageSeconds);
  if (typeof speedKmh === "number" && speedKmh > 80) score *= 0.3;
  return score;
}

/**
 * Score final para un cluster comunitario.
 *
 * Bonus por reporters: +0.1 por cada reporter adicional sobre el primero,
 * cap a 0.9 (no llega a 1.0 puro porque GPS celular tiene su límite).
 * 1 reporter = base, 2 reporters = +0.1, 3+ = +0.2.
 *
 * @param {object} opts
 *   - ageSeconds: segundos desde el último heartbeat del reporter
 *   - reporterCount: cantidad de users reportando este mismo bus
 *   - speedKmh: velocidad reportada (mismo cap físico que IMM)
 */
function forCommunity({ ageSeconds, reporterCount = 1, speedKmh = null }) {
  let score = freshnessScore(ageSeconds);
  if (typeof speedKmh === "number" && speedKmh > 80) score *= 0.3;
  const bonus = Math.min(0.2, Math.max(0, reporterCount - 1) * 0.1);
  return Math.min(0.9, score + bonus);
}

module.exports = {
  freshnessScore,
  forIMM,
  forCommunity,
};
