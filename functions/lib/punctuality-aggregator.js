/**
 * Aggregator de puntualidad de buses Mvd.
 *
 * Cruza `bus_arrivals` (BigQuery, eventos detectados por proximidad) con
 * el catálogo estático `stop-schedules.json` (horarios GTFS programados
 * por parada × línea × calendario) y clasifica cada arribo según el
 * delta Δt = (real - scheduled) en segundos:
 *
 *   - green       (-60  ≤ Δt ≤ +180)   en hora
 *   - yellowEarly (-600 ≤ Δt < -60)    impuntual leve adelantado
 *   - yellowLate  (+181 ≤ Δt ≤ +600)   impuntual leve atrasado
 *   - redEarly    (Δt ≤ -601)          impuntual grave adelantado
 *   - redLate     (Δt ≥ +601)          impuntual grave atrasado
 *
 * OTP = green / matched × 100 (estándar industrial, unmatched no entra).
 *
 * Filosofía: ventana verde asimétrica (60s early vs 180s late) —
 * anticiparse es peor que llegar tarde para el user (pierde el bus).
 * Bandas amarilla y roja simétricas. El cliente DATA agrupa los 4
 * yellow+red en colores únicos; futuros widgets discriminan early/late.
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

// Bandas de clasificación en segundos. Asimétrico en verde (favorece late
// porque anticiparse hace perder el bus). Simétrico en amarillo y rojo.
const BAND_GREEN_LO_SEC  = -60;   // verde: -60 ≤ Δt
const BAND_GREEN_HI_SEC  = 180;   // verde: Δt ≤ +180
const BAND_YELLOW_LO_SEC = -600;  // amarillo early: -600 ≤ Δt < -60
const BAND_YELLOW_HI_SEC = 600;   // amarillo late:  +181 ≤ Δt ≤ +600
const BAND_RED_ABS_SEC   = 601;   // rojo: |Δt| ≥ 601

const BANDS = Object.freeze({
  green:  { loSec: BAND_GREEN_LO_SEC,  hiSec: BAND_GREEN_HI_SEC },
  yellow: { loSec: BAND_YELLOW_LO_SEC, hiSec: BAND_YELLOW_HI_SEC },
  red:    { thresholdSec: BAND_RED_ABS_SEC },
});

const CATEGORIES = ["green", "yellowEarly", "yellowLate", "redEarly", "redLate"];

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
/**
 * @param {string} [dateStr] - YYYY-MM-DD UY. Si no se pasa, query ayer
 *   relativo a CURRENT_DATE UY (comportamiento default del cron diario).
 *   Pasarlo permite re-generar docs daily de cualquier día pasado.
 */
function buildQuery(dateStr) {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  const dateFilter = dateStr
    ? `DATE('${dateStr}')`
    : `DATE_SUB(CURRENT_DATE('America/Montevideo'), INTERVAL 1 DAY)`;
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
WHERE DATE(ts, 'America/Montevideo') = ${dateFilter}
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 2000000
`.trim();
}

async function runQuery(dateStr) {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildQuery(dateStr),
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

/**
 * Clasifica un delta (en minutos) en una de las 5 bandas según los
 * thresholds en segundos. Boundaries:
 *   redEarly    Δt ≤ -601s
 *   yellowEarly -600s ≤ Δt < -60s     (strict <, no incluye -60)
 *   green       -60s ≤ Δt ≤ +180s
 *   yellowLate  +181s ≤ Δt ≤ +600s    (strict >, no incluye +180)
 *   redLate     Δt ≥ +601s
 */
function classify(deltaMin) {
  const deltaSec = deltaMin * 60;
  if (deltaSec <= -BAND_RED_ABS_SEC)  return "redEarly";
  if (deltaSec >=  BAND_RED_ABS_SEC)  return "redLate";
  if (deltaSec <   BAND_GREEN_LO_SEC) return "yellowEarly";
  if (deltaSec >   BAND_GREEN_HI_SEC) return "yellowLate";
  return "green";
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
    green: 0,
    yellowEarly: 0,
    yellowLate: 0,
    redEarly: 0,
    redLate: 0,
    unmatched: 0,
    total: 0,
  }));
}

/**
 * Computa pcts por bucket. `greenPct` es el OTP del bucket (estándar
 * industrial). Los pcts amarillos y rojos son útiles para gráficas que
 * discriminan tipos de impuntualidad.
 *
 * Sparse: si `total` < SPARSE_BUCKET_THRESHOLD, todos los pcts son null
 * para evitar mostrar % engañosos con baja muestra.
 */
function finalizeHours(hours) {
  for (const b of hours) {
    if (b.total >= SPARSE_BUCKET_THRESHOLD) {
      b.greenPct       = b.green       / b.total;
      b.yellowEarlyPct = b.yellowEarly / b.total;
      b.yellowLatePct  = b.yellowLate  / b.total;
      b.redEarlyPct    = b.redEarly    / b.total;
      b.redLatePct     = b.redLate     / b.total;
      b.sparse = false;
    } else {
      b.greenPct       = null;
      b.yellowEarlyPct = null;
      b.yellowLatePct  = null;
      b.redEarlyPct    = null;
      b.redLatePct     = null;
      b.sparse = true;
    }
  }
}

function buildEmptyTotals() {
  return {
    matched: 0,
    unmatched: 0,
    green: 0,
    yellowEarly: 0,
    yellowLate: 0,
    redEarly: 0,
    redLate: 0,
  };
}

/**
 * `greenPct` es el OTP: green / matched. Convención industrial — unmatched
 * NO entra al denominador (no tiene Δt computable, va a otra métrica).
 */
function finalizeTotals(t) {
  t.greenPct = t.matched > 0 ? t.green / t.matched : null;
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
/**
 * @param {object} opts
 * @param {object} opts.admin - Firebase admin SDK
 * @param {function} opts.getStopSchedules
 * @param {string} [opts.dateStrOverride] - YYYY-MM-DD UY para regenerar
 *   un día pasado. Si no se pasa, calcula ayer (comportamiento default
 *   del cron diario). Útil para reproc histórico desde script ad-hoc.
 */
async function runAndPersist({ admin, getStopSchedules, dateStrOverride } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  const dateStr = dateStrOverride || yesterdayDateStrUY();

  let rows;
  try {
    rows = await runQuery(dateStrOverride);
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
      bands: BANDS,
      matchWindowMin: MATCH_WINDOW_MIN,
      sparseBucketThreshold: SPARSE_BUCKET_THRESHOLD,
      computedInMs,
    });

  logger.info(
    `aggregatePunctuality ${dateStr}: ${rows.length} arribos, matched=${result.totals.matched}, ` +
    `OTP green=${result.totals.green}/${result.totals.matched} ` +
    `(${result.totals.greenPct !== null ? (result.totals.greenPct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    dateStr,
    rows: rows.length,
    matched: result.totals.matched,
    greenPct: result.totals.greenPct,
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
      bands: BANDS,
      matchWindowMin: MATCH_WINDOW_MIN,
      windowMinutes: 60,
      computedInMs,
    });

  logger.info(
    `aggregatePunctualityHourly: ${rows.length} arribos última hora, matched=${result.totals.matched}, ` +
    `OTP green=${result.totals.green}/${result.totals.matched} ` +
    `(${result.totals.greenPct !== null ? (result.totals.greenPct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    rows: rows.length,
    matched: result.totals.matched,
    greenPct: result.totals.greenPct,
    computedInMs,
  };
}

// ─────────────────────────────────────────────────────────────────
// Variante ROLLING 24h — desde la última hora cerrada hacia atrás
// ─────────────────────────────────────────────────────────────────
//
// Spec user (Unif 21): "últimas 24h a partir de la última hora cerrada".
// Ej: ahora 16:13 UY → última hora cerrada 16:00 → ventana
// [2026-05-25 16:00, 2026-05-26 16:00). Misma estructura agregada que el
// cron daily (hours + totals + byCompany + byLine) pero rolling.
//
// Cadencia: cada hora UY al cruzar minuto 0. Entre runs el doc no cambia
// (la ventana es la misma hasta que cambia la hora).

function buildRolling24hQuery() {
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
WHERE ts >= TIMESTAMP_SUB(TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), HOUR), INTERVAL 24 HOUR)
  AND ts <  TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), HOUR)
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 2000000
`.trim();
}

async function runRolling24hQuery() {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildRolling24hQuery(),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/**
 * Mismo aggregate() que el daily (con hours + byCompany + byLine), pero
 * sobre la ventana rolling 24h. Devuelve además el rango temporal exacto
 * que se procesó para que el frontend pueda mostrarlo.
 */
async function runAndPersistRolling24h({ admin, getStopSchedules } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  let rows;
  try {
    rows = await runRolling24hQuery();
  } catch (e) {
    logger.error(`aggregatePunctualityRolling24h: BQ query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info(`aggregatePunctualityRolling24h: 0 rows — skip write`);
    return { ok: true, rows: 0, skipped: "no rows" };
  }

  const rawSchedules = await getStopSchedules();
  const indexed = indexSchedules(rawSchedules);
  const indexedStops = Object.keys(indexed).length;

  // dateStr puramente informativo — el doc es rolling, no asociado a 1 día.
  const result = aggregate(rows, indexed, "rolling-24h");
  const computedInMs = Date.now() - startMs;

  // Ventana exacta procesada (UTC). El cliente puede mostrarla como rango.
  const windowEnd = new Date();
  windowEnd.setUTCMinutes(0, 0, 0); // truncar al inicio de la hora actual UTC
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  await admin
    .firestore()
    .collection("punctuality_rolling_24h")
    .doc("latest")
    .set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rowsTotal: rows.length,
      indexedStops,
      bands: BANDS,
      matchWindowMin: MATCH_WINDOW_MIN,
      sparseBucketThreshold: SPARSE_BUCKET_THRESHOLD,
      windowStartUtc: windowStart.toISOString(),
      windowEndUtc: windowEnd.toISOString(),
      windowHours: 24,
      computedInMs,
    });

  logger.info(
    `aggregatePunctualityRolling24h: ${rows.length} arribos en [${windowStart.toISOString()}, ${windowEnd.toISOString()}), ` +
    `matched=${result.totals.matched}, OTP green=${result.totals.green}/${result.totals.matched} ` +
    `(${result.totals.greenPct !== null ? (result.totals.greenPct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    rows: rows.length,
    matched: result.totals.matched,
    greenPct: result.totals.greenPct,
    windowStartUtc: windowStart.toISOString(),
    windowEndUtc: windowEnd.toISOString(),
    computedInMs,
  };
}

// ─────────────────────────────────────────────────────────────────
// Variante TODAY — hoy parcial hasta la última hora cerrada UY
// ─────────────────────────────────────────────────────────────────
//
// Spec user Unif 21: "HOY tiene 24 columnas que se completan a medida
// que cierra la hora". Mismo aggregate() que el daily (hours[24] +
// totals + byCompany + byLine) pero filtrado al día calendario UY
// corriente, hasta la última hora cerrada (no incluye la hora en curso).
//
// Cadencia: cron cada 10 min para freshness. El bucket de la hora en
// curso permanece vacío hasta que cierre (al hacer hour-cross).

function buildTodayQuery() {
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
WHERE DATE(ts, 'America/Montevideo') = CURRENT_DATE('America/Montevideo')
  AND ts < TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), HOUR)
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 2000000
`.trim();
}

async function runTodayQuery() {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildTodayQuery(),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

function todayDateStrUY() {
  const now = new Date();
  const uy = new Date(now.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
  const y = uy.getFullYear();
  const m = String(uy.getMonth() + 1).padStart(2, "0");
  const d = String(uy.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function runAndPersistToday({ admin, getStopSchedules } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  const dateStr = todayDateStrUY();

  let rows;
  try {
    rows = await runTodayQuery();
  } catch (e) {
    logger.error(`aggregatePunctualityToday: BQ query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    // Edge case: arrancar el día sin ninguna hora cerrada aún (00:00-01:00).
    // Escribimos doc vacío para que el cliente sepa que "HOY" está disponible
    // pero sin data aún (todos los buckets `sparse: true`).
    const result = aggregate([], {}, dateStr);
    await admin
      .firestore()
      .collection("punctuality_today")
      .doc("latest")
      .set({
        ...result,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        rowsTotal: 0,
        indexedStops: 0,
        bands: BANDS,
        matchWindowMin: MATCH_WINDOW_MIN,
        sparseBucketThreshold: SPARSE_BUCKET_THRESHOLD,
        dateStrUY: dateStr,
        computedInMs: Date.now() - startMs,
      });
    logger.info(`aggregatePunctualityToday ${dateStr}: 0 rows (probablemente arranque del día) — escribió doc vacío`);
    return { ok: true, dateStr, rows: 0 };
  }

  const rawSchedules = await getStopSchedules();
  const indexed = indexSchedules(rawSchedules);
  const indexedStops = Object.keys(indexed).length;

  const result = aggregate(rows, indexed, dateStr);
  const computedInMs = Date.now() - startMs;

  await admin
    .firestore()
    .collection("punctuality_today")
    .doc("latest")
    .set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rowsTotal: rows.length,
      indexedStops,
      bands: BANDS,
      matchWindowMin: MATCH_WINDOW_MIN,
      sparseBucketThreshold: SPARSE_BUCKET_THRESHOLD,
      dateStrUY: dateStr,
      computedInMs,
    });

  logger.info(
    `aggregatePunctualityToday ${dateStr}: ${rows.length} arribos hasta última hora cerrada, ` +
    `matched=${result.totals.matched}, OTP green=${result.totals.green}/${result.totals.matched} ` +
    `(${result.totals.greenPct !== null ? (result.totals.greenPct * 100).toFixed(1) : "—"}%) ` +
    `en ${computedInMs}ms`
  );
  return {
    ok: true,
    dateStr,
    rows: rows.length,
    matched: result.totals.matched,
    greenPct: result.totals.greenPct,
    computedInMs,
  };
}

// ─────────────────────────────────────────────────────────────────
// Variante BY STOP — agregación por parada (Unif 21)
// ─────────────────────────────────────────────────────────────────
//
// Para el widget "Tu parada en vivo" (data.chevamo.com.uy/parada).
// Escribe 1 doc `punctuality_by_stop/latest` con un map `{stopId: stats}`
// agregado de las últimas N horas (configurable). 1 write Firestore por
// run, evita explosión de N=4937 writes individuales.
//
// Default: ventana últimas 24h (rolling desde NOW-24h, sin truncar). El
// frontend muestra "arribos última hora" usando count + extrapolación o
// hacemos query separada de 1h. Por ahora 24h da más samples por parada.

function buildByStopQuery({ windowHours = 24 } = {}) {
  const ds = `\`${BQ_PROJECT}.${BQ_DATASET}\``;
  return `
SELECT
  ts,
  line,
  stopId,
  EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Montevideo') * 60
    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/Montevideo') AS uyMinuteOfDay,
  EXTRACT(DAYOFWEEK FROM ts AT TIME ZONE 'America/Montevideo') - 1 AS uyDow
FROM ${ds}.bus_arrivals
WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowHours} HOUR)
  AND eventType = 'arrived'
  AND line IS NOT NULL AND line != ''
  AND stopId IS NOT NULL AND stopId != ''
LIMIT 5000000
`.trim();
}

async function runByStopQuery(opts) {
  const bq = getBqClient();
  const [job] = await bq.createQueryJob({
    query: buildByStopQuery(opts),
    location: BQ_LOCATION,
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

/**
 * Agrega arrivals por stopId. Para cada parada: count + OTP bandas
 * (green, yellowEarly, yellowLate, redEarly, redLate) + líneas distintas
 * vistas. Devuelve map `{stopId: stats}`.
 *
 * SPARSE_BUCKET_THRESHOLD adaptado: mínimo 10 arrivals para mostrar OTP%
 * (sino los % son ruido). Sin matched suficiente, greenPct=null y el
 * frontend muestra "Pocos datos".
 */
function aggregateByStop(rows, indexedSchedules) {
  const byStop = {}; // { stopId: { matched, unmatched, green, yellow*, red*, lines: Set, total } }
  const MIN_FOR_OTP = 10;

  for (const row of rows) {
    const stopId = String(row.stopId);
    const line = String(row.line);
    const uyDow = Number(row.uyDow);
    const realMin = Number(row.uyMinuteOfDay);

    if (!byStop[stopId]) {
      byStop[stopId] = {
        matched: 0, unmatched: 0,
        green: 0, yellowEarly: 0, yellowLate: 0, redEarly: 0, redLate: 0,
        total: 0, lines: new Set(),
      };
    }
    const s = byStop[stopId];
    s.total++;
    s.lines.add(line);

    const stopMap = indexedSchedules[stopId];
    if (!stopMap) { s.unmatched++; continue; }
    const lineMap = stopMap[line];
    if (!lineMap) { s.unmatched++; continue; }
    const calKey = calendarKeyFromDow(uyDow);
    const arr = lineMap[calKey];
    if (!arr) { s.unmatched++; continue; }
    const delta = findClosestSchedule(realMin, arr);
    if (delta === null) { s.unmatched++; continue; }

    const cls = classify(delta);
    s.matched++;
    s[cls]++;
  }

  // Finalize: convert lines Set → count + array, compute OTP.
  const out = {};
  for (const [stopId, s] of Object.entries(byStop)) {
    out[stopId] = {
      total:        s.total,
      matched:      s.matched,
      unmatched:    s.unmatched,
      green:        s.green,
      yellowEarly:  s.yellowEarly,
      yellowLate:   s.yellowLate,
      redEarly:     s.redEarly,
      redLate:      s.redLate,
      linesCount:   s.lines.size,
      greenPct:     s.matched >= MIN_FOR_OTP ? s.green / s.matched : null,
      sparse:       s.matched < MIN_FOR_OTP,
    };
  }
  return out;
}

async function runAndPersistByStop({ admin, getStopSchedules, windowHours = 24 } = {}) {
  if (!admin) throw new Error("admin SDK requerido");
  if (typeof getStopSchedules !== "function") {
    throw new Error("getStopSchedules requerido");
  }
  const startMs = Date.now();
  let rows;
  try {
    rows = await runByStopQuery({ windowHours });
  } catch (e) {
    logger.error(`aggregateByStop: BQ query failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!rows || rows.length === 0) {
    logger.info(`aggregateByStop: 0 rows — skip`);
    return { ok: true, rows: 0, skipped: "no rows" };
  }
  const rawSchedules = await getStopSchedules();
  const indexed = indexSchedules(rawSchedules);
  const byStop = aggregateByStop(rows, indexed);
  const stopsCount = Object.keys(byStop).length;
  const computedInMs = Date.now() - startMs;

  // Firestore tiene límite 40k index entries por doc (no 1MB de payload).
  // Con ~5000 stops × ~13 fields cada uno = 65k entries → excede.
  // Solución: serializar `byStop` a JSON string (no indexable, no contribuye
  // a index entries). El cliente parsea con JSON.parse local. Tradeoff:
  // no podés query Firestore por byStop.X, pero como leemos el doc entero
  // y filtramos local, no es problema.
  const byStopJson = JSON.stringify(byStop);
  await admin
    .firestore()
    .collection("punctuality_by_stop")
    .doc("latest")
    .set({
      byStopJson,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rowsTotal: rows.length,
      stopsCount,
      windowHours,
      bands: BANDS,
      minSamplesForOtp: 10,
      computedInMs,
    });

  logger.info(
    `aggregateByStop: ${rows.length} arribos sobre ${stopsCount} paradas ` +
    `en ${windowHours}h, en ${computedInMs}ms`
  );
  return { ok: true, rows: rows.length, stopsCount, computedInMs };
}

module.exports = {
  BANDS,
  CATEGORIES,
  BAND_GREEN_LO_SEC,
  BAND_GREEN_HI_SEC,
  BAND_YELLOW_LO_SEC,
  BAND_YELLOW_HI_SEC,
  BAND_RED_ABS_SEC,
  MATCH_WINDOW_MIN,
  SPARSE_BUCKET_THRESHOLD,
  COMPANY_KEYS,
  buildQuery,
  buildHourlyQuery,
  buildRolling24hQuery,
  buildTodayQuery,
  hhmmssToMinutes,
  indexSchedules,
  findClosestSchedule,
  classify,
  normalizeCompany,
  aggregate,
  aggregateHourly,
  yesterdayDateStrUY,
  todayDateStrUY,
  runAndPersist,
  runAndPersistHourly,
  runAndPersistRolling24h,
  runAndPersistToday,
  buildByStopQuery,
  aggregateByStop,
  runAndPersistByStop,
};
