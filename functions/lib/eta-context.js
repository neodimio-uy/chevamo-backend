/**
 * Multiplicadores de contexto del Smart ETA.
 *
 * Port directo de iOS `Vamo/Models/ETAContext.swift`. Funciones puras y
 * determinísticas: dado un input, mismo output. Sin state, sin async,
 * sin dependencias externas — testeable y trivialmente cacheable.
 *
 * Convención: TODO el cómputo de hora/día usa zona Uruguay (UTC-3),
 * porque el servidor corre en sa-east1 pero podría migrar y el feed IMM
 * vive en hora local de Mvd.
 *
 * Si alguna día queremos hacer la lista de feriados dinámica, el roadmap
 * es Remote Config con un array `holidays_uy_2027` o un endpoint
 * `/holidays?country=UY`. Por ahora simple es mejor: la lista cambia
 * 1 vez al año.
 */

const TZ_UY = "America/Montevideo";

/** Segundos de penalty por cada parada intermedia entre el bus y el destino. */
const SECONDS_PER_INTERMEDIATE_STOP = 18;

/** Bandas de hora pico para el bucket de calibración. */
const HOUR_BAND = {
  VALLEY: 0,
  PEAK_AM: 1,
  PEAK_PM: 2,
  NIGHT: 3,
};

/**
 * Devuelve `Date` ajustado a hora local UY. Útil para extraer hour/dow
 * sin sorpresas. Usa `toLocaleString` que es lo más portable en Node sin
 * deps externas.
 */
function uyDate(date = new Date()) {
  // toLocaleString("en-US", { timeZone: ... }) devuelve algo como
  // "5/23/2026, 9:30:45 PM" — re-parsearlo da un Date que cuando le
  // pedimos getHours() devuelve la hora UY.
  return new Date(date.toLocaleString("en-US", { timeZone: TZ_UY }));
}

function uyHour(date = new Date()) {
  return uyDate(date).getHours();
}

/** 0 = domingo, 6 = sábado. Compatible con Date.getDay() pero en hora UY. */
function uyDayOfWeek(date = new Date()) {
  return uyDate(date).getDay();
}

/** "YYYY-MM-DD" en hora UY. */
function uyDateString(date = new Date()) {
  const d = uyDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Mapea hora 0-23 a una banda. Calibración usa esto como dimensión. */
function hourToBand(hour) {
  if (hour >= 7 && hour <= 8) return HOUR_BAND.PEAK_AM;
  if (hour >= 17 && hour <= 18) return HOUR_BAND.PEAK_PM;
  if (hour >= 22 || hour <= 4) return HOUR_BAND.NIGHT;
  return HOUR_BAND.VALLEY;
}

/**
 * Feriados nacionales Uruguay 2026-2027. Formato "YYYY-MM-DD".
 * Fuente: Ley 12.243 + decretos anuales (Min. Trabajo UY). Carnaval, Turismo
 * y Día del Patrimonio dependen del año — actualizar cada diciembre.
 */
const HOLIDAYS_UY = new Set([
  // 2026
  "2026-01-01", // Año Nuevo
  "2026-01-06", // Reyes / Día de los Niños
  "2026-02-16", // Carnaval (lunes)
  "2026-02-17", // Carnaval (martes)
  "2026-04-02", // Jueves de Turismo
  "2026-04-03", // Viernes de Turismo
  "2026-04-19", // Desembarco de los 33
  "2026-04-20", // Desembarco (movido)
  "2026-05-01", // Día del Trabajador
  "2026-05-18", // Batalla de Las Piedras
  "2026-06-19", // Natalicio de Artigas
  "2026-07-18", // Jura de la Constitución
  "2026-08-25", // Declaratoria de Independencia
  "2026-10-12", // Día de la Raza (movido)
  "2026-11-02", // Día de los Difuntos
  "2026-12-25", // Navidad
  // 2027
  "2027-01-01",
  "2027-01-06",
  "2027-02-08",
  "2027-02-09",
  "2027-03-25",
  "2027-03-26",
  "2027-04-19",
  "2027-05-01",
  "2027-05-17",
  "2027-06-21",
  "2027-07-18",
  "2027-08-25",
  "2027-10-11",
  "2027-11-02",
  "2027-12-25",
]);

function isHoliday(date = new Date()) {
  return HOLIDAYS_UY.has(uyDateString(date));
}

/**
 * Factor multiplicador por hora local UY (recalibrado 2026-04-24).
 * El feed IMM ya viene con velocidad afectada por tráfico, así que
 * multiplicar por factores altos sobre-corrige.
 */
function hourMultiplier(date = new Date()) {
  const h = uyHour(date);
  if (h >= 7 && h <= 8) return 1.30;  // pico AM
  if (h >= 17 && h <= 18) return 1.40; // pico PM
  if (h >= 22 || h <= 4) return 0.85;  // noche
  return 1.00;
}

/**
 * Factor multiplicador por día de la semana. Feriado en hábil = domingo.
 * Si el feriado cae en fin de semana, ya viene con su multiplier propio
 * (no compound).
 */
function weekdayMultiplier(date = new Date()) {
  const dow = uyDayOfWeek(date);
  if (dow === 0) return 0.85;          // domingo
  if (dow === 6) return 0.92;          // sábado
  if (isHoliday(date)) return 0.85;    // feriado en hábil
  return 1.00;                          // lun-vie
}

/**
 * "wd" | "sat" | "sun" | "holiday" — dimensión del bucket de calibración.
 */
function dayKind(date = new Date()) {
  if (isHoliday(date)) return "holiday";
  const dow = uyDayOfWeek(date);
  if (dow === 0) return "sun";
  if (dow === 6) return "sat";
  return "wd";
}

/**
 * Intensidades de lluvia. Postergado server-side hasta Sprint 0+1 con
 * Open-Meteo. Por ahora siempre "none" → factor 1.00.
 */
function weatherMultiplier(intensity = "none") {
  switch (intensity) {
    case "none":         return 1.00;
    case "light":        return 1.08;
    case "moderate":     return 1.18;
    case "heavy":        return 1.30;
    case "thunderstorm": return 1.45;
    default:             return 1.00;
  }
}

/**
 * Aplica la fórmula Smart ETA completa:
 *   eta_final = (base + 18s × intermediateStops) ×
 *               hour × day × weather × calibration
 *
 * Mirror de `ETAContext.apply` (iOS). Postergamos `intermediateStops`
 * en backend porque requiere reconstruir el shape entre bus actual y
 * parada destino — el cliente ya lo calcula. Lo dejamos como param
 * opcional para uso futuro.
 */
function apply({
  baseEtaSec,
  intermediateStops = 0,
  date = new Date(),
  rainIntensity = "none",
  calibrationFactor = 1.0,
}) {
  const penalty = intermediateStops * SECONDS_PER_INTERMEDIATE_STOP;
  const mult =
    hourMultiplier(date) *
    weekdayMultiplier(date) *
    weatherMultiplier(rainIntensity) *
    calibrationFactor;
  return (baseEtaSec + penalty) * mult;
}

module.exports = {
  TZ_UY,
  HOUR_BAND,
  SECONDS_PER_INTERMEDIATE_STOP,
  uyDate,
  uyHour,
  uyDayOfWeek,
  uyDateString,
  hourToBand,
  isHoliday,
  hourMultiplier,
  weekdayMultiplier,
  dayKind,
  weatherMultiplier,
  apply,
};
