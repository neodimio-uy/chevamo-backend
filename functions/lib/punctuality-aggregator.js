/**
 * Aggregator diario de puntualidad de buses Mvd.
 *
 * Cruza `bus_arrivals` (BigQuery, eventos detectados por proximidad) con
 * el catálogo estático `stop-schedules.json` (horarios GTFS programados
 * por parada × línea × calendario) y clasifica cada arribo en:
 *
 *   - early   (delta < -5 min, llegó antes de lo programado)
 *   - onTime  (|delta| ≤ 5 min, puntual)
 *   - late    (delta > +5 min, llegó tarde)
 *
 * Agrega por hora del día (0-23h UY) y escribe a Firestore
 * `punctuality_daily/{YYYY-MM-DD}` con 24 buckets. El endpoint
 * `/stats/punctuality` lee de Firestore con cache.
 *
 * Threshold privacidad: buckets con <50 muestras se marcan como
 * `sparse: true` para que el frontend los muestre en gris sin %.
 *
 * Limitaciones v1:
 *   - Match al schedule más cercano en valor absoluto (±30min ventana).
 *     Si un bus llega muy tarde puede matchear al siguiente schedule —
 *     futuro: usar trip_id si lo agregamos a `bus_arrivals`.
 *   - Solo Mvd (los stopId del JSON son del catálogo IMM).
 *   - Cross-midnight schedules ("25:30:00" GTFS) → módulo 24.
 *
 * Costo: 1 query/día scan ~30-50MB → <$0.01/mes. Despreciable.
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { logger } = require("firebase-functions");

const BQ_PROJECT = process.env.GCLOUD_PROJECT || "vamo-dbad6";
const BQ_DATASET = process.env.BQ_TELEMETRY_DATASET || "vamo_telemetry";
const BQ_LOCATION = process.env.BQ_TELEMETRY_LOCATION || "southamerica-east1";

const ON_TIME_THRESHOLD_MIN = 5;     // ±5 min = puntual
const MATCH_WINDOW_MIN = 30;          // ventana búsqueda en schedule
const SPARSE_BUCKET_THRESHOLD = 50;   // <50 muestras → bucket sparse

let bqClient = null;
function getBqClient() {
  if (bqClient) return bqClient;
  bqClient = new BigQuery({ projectId: BQ_PROJECT });
  return bqClient;
}

/**
 * Query BQ que extrae arribos de AYER en hora local UY.
 *
 * Filtros:
 *   - Ventana = el día calendario UY anterior (00:00 a 23:59:59 UY).
 *   - eventType = 'arrived' (no incluir 'departed').
 *   - line + stopId no vacíos.
 *
 * Output campos:
 *   - ts (timestamp UTC)
 *   - line, stopId, company
 *   - uyHour (0-23) — para bucket agregado
 *   - uyMinuteOfDay (0-1439) — para match contra schedule
 *   - uyDow (0=Sun, 1=Mon, ..., 6=Sat) — para elegir WD/Sat/Sun
 */
function buildQuery() {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  return `
SELECT
  ts,
  line,
  stopId,
  company,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Montevideo') AS uyHour,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Montevideo') * 60
    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/Montevideo') AS uyMinuteOfDay,
  EXTRACT(DAYOFWEEK FROM ts AT TIME ZONE 'America/Montevideo') - 1 AS uyDow
FROM ${ds}.bus_arrivals
WHERE DATE(ts, 'America/Montevideo') = DATE_SUB(CURRENT_DATE('America/Montevideo'), INTERVAL 1 DAY)
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 2000000
`.trim();
}

async function runQuery() {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildQuery(),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/**
 * Convierte "HH:MM:SS" → minutos del día. Soporta horas GTFS >= 24
 * (servicios cross-midnight como "25:30:00" para 01:30 AM día siguiente):
 * normalizamos módulo 24 — para fines de match contra arribos reales
 * que siempre están en 0-23h, eso es suficiente.
 */
function hhmmssToMinutes(s) {
  if (!s || typeof s !== "string") return null;
  const parts = s.split(":");
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h % 24) * 60 + m;
}

/**
 * Pre-procesa el catálogo de schedules a un formato indexado
 * `{stopId: {line: {WD: [min], Sat: [min], Sun: [min]}}}` con valores
 * en minutos del día. Ordenados ascendentemente para búsqueda binaria.
 *
 * Llamar UNA VEZ por invocación del cron (~3-5s, evita recomputar
 * 1M veces por row).
 */
function indexSchedules(rawSchedules) {
  const indexed = {};
  for (const stopId of Object.keys(rawSchedules)) {
    const lineMap = rawSchedules[stopId];
    if (!lineMap || typeof lineMap !== "object") continue;
    const out = {};
    for (const line of Object.keys(lineMap)) {
      const cals = lineMap[line];
      if (!cals || typeof cals !== "object") continue;
      const o = {};
      for (const cal of ["WD", "Sat", "Sun"]) {
        const arr = cals[cal];
        if (!Array.isArray(arr)) continue;
        const minutes = arr
          .map(hhmmssToMinutes)
          .filter((m) => Number.isFinite(m))
          .sort((a, b) => a - b);
        if (minutes.length > 0) o[cal] = minutes;
      }
      if (Object.keys(o).length > 0) out[line] = o;
    }
    if (Object.keys(out).length > 0) indexed[stopId] = out;
  }
  return indexed;
}

function calendarKeyFromDow(uyDow) {
  if (uyDow === 0) return "Sun";
  if (uyDow === 6) return "Sat";
  return "WD";
}

/**
 * Búsqueda binaria del horario programado más cercano al real, dentro
 * de la ventana ±MATCH_WINDOW_MIN. Devuelve `delta_min` (real - scheduled)
 * o `null` si no hay match en ventana.
 */
function findClosestSchedule(realMin, scheduledArr) {
  if (!scheduledArr || scheduledArr.length === 0) return null;
  // Binary search del primer elemento >= realMin
  let lo = 0;
  let hi = scheduledArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (scheduledArr[mid] < realMin) lo = mid + 1;
    else hi = mid;
  }
  // Candidatos: scheduledArr[lo] (>=) y scheduledArr[lo-1] (<)
  const candidates = [];
  if (lo < scheduledArr.length) candidates.push(scheduledArr[lo]);
  if (lo > 0) candidates.push(scheduledArr[lo - 1]);
  let best = null;
  let bestDelta = Infinity;
  for (const s of candidates) {
    const delta = realMin - s;
    if (Math.abs(delta) < Math.abs(bestDelta)) {
      bestDelta = delta;
      best = s;
    }
  }
  if (best === null || Math.abs(bestDelta) > MATCH_WINDOW_MIN) return null;
  return bestDelta;
}

function classify(deltaMin) {
  if (deltaMin < -ON_TIME_THRESHOLD_MIN) return "early";
  if (deltaMin > ON_TIME_THRESHOLD_MIN) return "late";
  return "onTime";
}

// Empresas Mvd canónicas. Buckets para desagregación. Cualquier valor
// que no matchee va a "OTHER" (preservar para diagnostics; no se muestra
// en el frontend).
const COMPANY_KEYS = ["CUTCSA", "COETC", "COMESA", "UCOT", "OTHER"];

/**
 * Normaliza nombre de empresa del feed IMM a una de las canónicas.
 * Valores observados en BQ bus_arrivals (2026-05-24): CUTCSA, COETC,
 * UCOT, COME (sí, "COME" sin SA), NULL. Match exacto + fallback a
 * substring para cubrir futuras variantes ("COETC SA", etc.).
 */
function normalizeCompany(raw) {
  if (!raw) return "OTHER";
  const c = String(raw).toUpperCase().trim();
  // Match exacto primero (rápido, cubre 99% de los casos reales).
  if (c === "CUTCSA") return "CUTCSA";
  if (c === "COETC") return "COETC";
  if (c === "COME" || c === "COMESA") return "COMESA";
  if (c === "UCOT") return "UCOT";
  // Fallback substring para variantes con sufijos ("CUTCSA SA",
  // "COMESA SRL", etc.).
  if (c.includes("CUTCSA")) return "CUTCSA";
  if (c.includes("COETC")) return "COETC";
  if (c.startsWith("COME")) return "COMESA";
  if (c.includes("UCOT")) return "UCOT";
  return "OTHER";
}

function buildEmptyHours() {
  return Array.from({ length: 24 }, (_, h) => ({
    h,
    early: 0,
    onTime: 0,
    late: 0,
    unmatched: 0,
    total: 0,
  }));
}

function finalizeHours(hours) {
  for (const b of hours) {
    if (b.total >= SPARSE_BUCKET_THRESHOLD) {
      b.earlyPct = b.early / b.total;
      b.onTimePct = b.onTime / b.total;
      b.latePct = b.late / b.total;
      b.sparse = false;
    } else {
      b.earlyPct = null;
      b.onTimePct = null;
      b.latePct = null;
      b.sparse = true;
    }
  }
}

function buildEmptyTotals() {
  return { matched: 0, unmatched: 0, early: 0, onTime: 0, late: 0 };
}

function finalizeTotals(t) {
  t.onTimePct = t.matched > 0 ? t.onTime / t.matched : null;
  return t;
}

/**
 * Procesa rows BQ contra el catálogo indexado, agrega por hora, por
 * empresa y por línea. Devuelve:
 *   { date, hours: [...24] (total), totals,
 *     byCompany: { CUTCSA: { hours, totals }, ... },
 *     byLine: { "169": { totals }, "522": { totals }, ... } }
 *
 * `byLine` solo trackea totals (no hours) — el frontend lo usa para
 * rankings de "líneas más puntuales", no para gráficas por hora.
 */
function aggregate(rows, indexedSchedules, dateStr) {
  const hours = buildEmptyHours();
  const totals = buildEmptyTotals();
  const byCompany = {};
  for (const key of COMPANY_KEYS) {
    byCompany[key] = { hours: buildEmptyHours(), totals: buildEmptyTotals() };
  }
  // byLine usa string keys dinámicas (~150 líneas activas Mvd). Crear
  // lazy en el loop para no inicializar buckets vacíos de líneas que
  // no aparecen en el feed del día.
  const byLine = {};

  for (const row of rows) {
    const stopId = String(row.stopId);
    const line = String(row.line);
    const uyHour = Number(row.uyHour);
    const uyDow = Number(row.uyDow);
    const realMin = Number(row.uyMinuteOfDay);
    const companyKey = normalizeCompany(row.company);
    if (!Number.isFinite(uyHour) || uyHour < 0 || uyHour > 23) continue;

    const ensureLineBucket = () => {
      if (!byLine[line]) byLine[line] = buildEmptyTotals();
      return byLine[line];
    };
    const incrementUnmatched = () => {
      hours[uyHour].unmatched++;
      totals.unmatched++;
      byCompany[companyKey].hours[uyHour].unmatched++;
      byCompany[companyKey].totals.unmatched++;
      ensureLineBucket().unmatched++;
    };

    const stopMap = indexedSchedules[stopId];
    if (!stopMap) { incrementUnmatched(); continue; }
    const lineMap = stopMap[line];
    if (!lineMap) { incrementUnmatched(); continue; }
    const calKey = calendarKeyFromDow(uyDow);
    const arr = lineMap[calKey];
    if (!arr) { incrementUnmatched(); continue; }
    const delta = findClosestSchedule(realMin, arr);
    if (delta === null) { incrementUnmatched(); continue; }

    const cls = classify(delta);
    // Total (todas empresas)
    hours[uyHour][cls]++;
    hours[uyHour].total++;
    totals.matched++;
    totals[cls]++;
    // Per-empresa
    const cb = byCompany[companyKey];
    cb.hours[uyHour][cls]++;
    cb.hours[uyHour].total++;
    cb.totals.matched++;
    cb.totals[cls]++;
    // Per-línea
    const lb = ensureLineBucket();
    lb.matched++;
    lb[cls]++;
  }

  finalizeHours(hours);
  finalizeTotals(totals);
  for (const key of COMPANY_KEYS) {
    finalizeHours(byCompany[key].hours);
    finalizeTotals(byCompany[key].totals);
  }
  for (const line of Object.keys(byLine)) {
    finalizeTotals(byLine[line]);
  }

  return { date: dateStr, hours, totals, byCompany, byLine };
}

/**
 * Calcula el string YYYY-MM-DD de AYER en hora UY (consistente con
 * el filtro WHERE de la query).
 */
function yesterdayDateStrUY() {
  const now = new Date();
  const uy = new Date(now.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
  uy.setDate(uy.getDate() - 1);
  const y = uy.getFullYear();
  const m = String(uy.getMonth() + 1).padStart(2, "0");
  const d = String(uy.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Entry point del cron. Idempotente: si la query falla o no hay data,
 * NO sobreescribe el doc anterior (preserva el último día válido).
 *
 * Inyectamos `admin` y `getStopSchedules` para testeabilidad y para
 * no acoplar este módulo al boot de index.js.
 */
async function runAndPersist({ admin, getStopSchedules } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  const dateStr = yesterdayDateStrUY();

  let rows;
  try {
    rows = await runQuery();
  } catch (e) {
    logger.error(`aggregatePunctuality: BQ query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info(`aggregatePunctuality: 0 rows for ${dateStr} — skip write`);
    return { ok: true, dateStr, rows: 0, skipped: "no rows" };
  }

  const rawSchedules = await getStopSchedules();
  const indexed = indexSchedules(rawSchedules);
  const indexedStops = Object.keys(indexed).length;

  const result = aggregate(rows, indexed, dateStr);
  const computedInMs = Date.now() - startMs;

  await admin
    .firestore()
    .collection("punctuality_daily")
    .doc(dateStr)
    .set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rowsTotal: rows.length,
      indexedStops,
      onTimeThresholdMin: ON_TIME_THRESHOLD_MIN,
      matchWindowMin: MATCH_WINDOW_MIN,
      sparseBucketThreshold: SPARSE_BUCKET_THRESHOLD,
      computedInMs,
    });

  logger.info(
    `aggregatePunctuality ${dateStr}: ${rows.length} arribos, matched=${result.totals.matched}, ` +
    `puntual=${result.totals.onTime}/${result.totals.matched} ` +
    `(${result.totals.onTimePct !== null ? (result.totals.onTimePct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    dateStr,
    rows: rows.length,
    matched: result.totals.matched,
    onTimePct: result.totals.onTimePct,
    computedInMs,
  };
}

// ─────────────────────────────────────────────────────────────────
// Variante HOURLY — última hora UY, agregación solo por línea
// ─────────────────────────────────────────────────────────────────
//
// Se usa para el ranking "Líneas más puntuales — última hora" en el TV
// mode. Query distinta (rolling 60 min) + agregación más simple (solo
// byLine, sin hours buckets ni byCompany — no se necesita esa granularidad
// en una ventana tan corta).
//
// Cadencia: cron cada 10 min. Doc destino: `punctuality_hourly/latest`
// (sobrescribe).

function buildHourlyQuery() {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  return `
SELECT
  ts,
  line,
  stopId,
  company,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Montevideo') AS uyHour,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Montevideo') * 60
    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/Montevideo') AS uyMinuteOfDay,
  EXTRACT(DAYOFWEEK FROM ts AT TIME ZONE 'America/Montevideo') - 1 AS uyDow
FROM ${ds}.bus_arrivals
WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 MINUTE)
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 200000
`.trim();
}

async function runHourlyQuery() {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildHourlyQuery(),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/**
 * Solo byLine + totals. No hours buckets ni byCompany (ventana muy
 * corta para que esos breakdowns sean útiles).
 */
function aggregateHourly(rows, indexedSchedules) {
  const totals = buildEmptyTotals();
  const byLine = {};

  for (const row of rows) {
    const stopId = String(row.stopId);
    const line = String(row.line);
    const uyDow = Number(row.uyDow);
    const realMin = Number(row.uyMinuteOfDay);
    if (!byLine[line]) byLine[line] = buildEmptyTotals();
    const lb = byLine[line];

    const stopMap = indexedSchedules[stopId];
    if (!stopMap) { totals.unmatched++; lb.unmatched++; continue; }
    const lineMap = stopMap[line];
    if (!lineMap) { totals.unmatched++; lb.unmatched++; continue; }
    const calKey = calendarKeyFromDow(uyDow);
    const arr = lineMap[calKey];
    if (!arr) { totals.unmatched++; lb.unmatched++; continue; }
    const delta = findClosestSchedule(realMin, arr);
    if (delta === null) { totals.unmatched++; lb.unmatched++; continue; }

    const cls = classify(delta);
    totals.matched++;
    totals[cls]++;
    lb.matched++;
    lb[cls]++;
  }

  finalizeTotals(totals);
  for (const line of Object.keys(byLine)) finalizeTotals(byLine[line]);

  return { totals, byLine };
}

async function runAndPersistHourly({ admin, getStopSchedules } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  let rows;
  try {
    rows = await runHourlyQuery();
  } catch (e) {
    logger.error(`aggregatePunctualityHourly: BQ query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info(`aggregatePunctualityHourly: 0 rows en última hora — skip`);
    return { ok: true, rows: 0, skipped: "no rows" };
  }
  const rawSchedules = await getStopSchedules();
  const indexed = indexSchedules(rawSchedules);

  const result = aggregateHourly(rows, indexed);
  const computedInMs = Date.now() - startMs;

  await admin
    .firestore()
    .collection("punctuality_hourly")
    .doc("latest")
    .set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rowsTotal: rows.length,
      onTimeThresholdMin: ON_TIME_THRESHOLD_MIN,
      matchWindowMin: MATCH_WINDOW_MIN,
      windowMinutes: 60,
      computedInMs,
    });

  logger.info(
    `aggregatePunctualityHourly: ${rows.length} arribos última hora, matched=${result.totals.matched}, ` +
    `puntual=${result.totals.onTime}/${result.totals.matched} ` +
    `(${result.totals.onTimePct !== null ? (result.totals.onTimePct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    rows: rows.length,
    matched: result.totals.matched,
    onTimePct: result.totals.onTimePct,
    computedInMs,
  };
}

module.exports = {
  ON_TIME_THRESHOLD_MIN,
  MATCH_WINDOW_MIN,
  SPARSE_BUCKET_THRESHOLD,
  COMPANY_KEYS,
  buildQuery,
  buildHourlyQuery,
  hhmmssToMinutes,
  indexSchedules,
  findClosestSchedule,
  classify,
  normalizeCompany,
  aggregate,
  aggregateHourly,
  yesterdayDateStrUY,
  runAndPersist,
  runAndPersistHourly,
};
