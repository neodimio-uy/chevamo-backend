/**
 * Schema canónico de clima actual.
 * Fuente: Google Maps Platform Weather API (`currentConditions:lookup`).
 * Cliente iOS: struct `Weather` en Weather.swift.
 *
 * El adapter (`adapters/googleWeather.js`) mapea la respuesta cruda de Google
 * a esta shape. El ETA context factor lee `precipitationMm > 0` para decidir
 * si aplicar el multiplicador de lluvia.
 */

const { z } = require("zod");

// Categorías canónicas de Vamo — consolidan los 30+ enums de Google en un set
// manejable. El adapter hace el mapping de Google → estas categorías.
const WeatherConditionSchema = z.enum([
  "clear",          // despejado / soleado
  "partly-cloudy",  // parcialmente nublado
  "cloudy",         // nublado
  "rain",           // lluvia (cualquier intensidad)
  "thunderstorm",   // tormenta eléctrica
  "snow",           // nieve (rare en Mdvo pero mapeado)
  "fog",            // niebla
  "windy",          // viento significativo sin precipitación
  "unknown",        // fallback si Google devuelve algo que no mapea
]);

// Cardinal del viento — 8 puntos cardinales más "calm" cuando no hay viento.
const WindCardinalSchema = z.enum([
  "N", "NE", "E", "SE", "S", "SW", "W", "NW", "calm",
]);

const WeatherCurrentSchema = z.object({
  tempC:               z.number(),
  feelsLikeC:          z.number().nullable().optional(),
  condition:           WeatherConditionSchema,
  description:         z.string(),       // human-readable es-UY
  isDaytime:           z.boolean(),
  humidityPct:         z.number().int().min(0).max(100),
  precipitationMm:     z.number().nonnegative(),
  precipitationProbPct: z.number().int().min(0).max(100),
  windKmh:             z.number().nonnegative(),
  uvIndex:             z.number().int().min(0).max(15),

  // Campos sumados en B1 (extracción 2026-04-26 — Google ya los mandaba en
  // currentConditions:lookup pero los descartábamos). Todos opcionales para
  // compatibilidad con clientes viejos: si Google no manda algún campo, queda
  // null y el cliente decide si renderiza el slot o lo oculta.
  windDirectionDeg:    z.number().min(0).max(360).nullable().optional(),
  windCardinal:        WindCardinalSchema.nullable().optional(),
  windGustKmh:         z.number().nonnegative().nullable().optional(),
  pressureHpa:         z.number().positive().nullable().optional(),
  dewPointC:           z.number().nullable().optional(),
  visibilityKm:        z.number().nonnegative().nullable().optional(),
  cloudCoverPct:       z.number().int().min(0).max(100).nullable().optional(),
  // Sunrise/sunset en ISO 8601 (timezone Mvd). Cliente iOS los parsea con
  // ISO8601DateFormatter para dibujar el arco solar. Nullable porque Google
  // puede no devolverlos en latitudes polares — en UY siempre vienen.
  sunriseISO:          z.string().nullable().optional(),
  sunsetISO:           z.string().nullable().optional(),
});

// MARK: - Forecast hourly (B2)
//
// Cada slot representa una hora futura — la 0 es la hora siguiente al
// `currentTime` que reporta Google, no la hora actual del wall clock.
// El cliente arma el strip horizontal con esta lista; cada item es
// independiente (no requiere context del current).
const WeatherForecastHourSchema = z.object({
  timeISO:              z.string(),                              // ISO 8601 con TZ
  hour:                 z.number().int().min(0).max(23),         // hora local 0-23
  tempC:                z.number(),
  feelsLikeC:           z.number().nullable().optional(),
  condition:            WeatherConditionSchema,
  description:          z.string(),
  isDaytime:            z.boolean(),
  precipitationMm:      z.number().nonnegative(),
  precipitationProbPct: z.number().int().min(0).max(100),
  windKmh:              z.number().nonnegative(),
  windCardinal:         WindCardinalSchema.nullable().optional(),
  humidityPct:          z.number().int().min(0).max(100).nullable().optional(),
  uvIndex:              z.number().int().min(0).max(15).nullable().optional(),
});

const WeatherForecastHourlySchema = z.object({
  hours: z.array(WeatherForecastHourSchema).min(1).max(48),
});

// MARK: - Forecast daily (B3)
//
// Cada item es un día (hoy + futuros). Google Weather API soporta hasta 10
// días de pronóstico. La fase lunar es nice-to-have (Nivel C la usa); por
// ahora la pasamos como string opcional sin enum estricto.
const MoonPhaseSchema = z.enum([
  "new",
  "waxing-crescent",
  "first-quarter",
  "waxing-gibbous",
  "full",
  "waning-gibbous",
  "last-quarter",
  "waning-crescent",
]);

const WeatherForecastDaySchema = z.object({
  dateISO:              z.string(),                              // YYYY-MM-DD
  dayOfWeek:            z.number().int().min(1).max(7),          // 1=lun..7=dom
  tempMaxC:             z.number(),
  tempMinC:             z.number(),
  condition:            WeatherConditionSchema,                  // condición dominante del día
  description:          z.string(),
  precipitationMm:      z.number().nonnegative(),
  precipitationProbPct: z.number().int().min(0).max(100),
  windKmh:              z.number().nonnegative(),
  windCardinal:         WindCardinalSchema.nullable().optional(),
  uvIndexMax:           z.number().int().min(0).max(15),
  humidityAvgPct:       z.number().int().min(0).max(100).nullable().optional(),
  sunriseISO:           z.string().nullable().optional(),
  sunsetISO:            z.string().nullable().optional(),
  moonriseISO:          z.string().nullable().optional(),
  moonsetISO:           z.string().nullable().optional(),
  moonPhase:            MoonPhaseSchema.nullable().optional(),
});

const WeatherForecastDailySchema = z.object({
  days: z.array(WeatherForecastDaySchema).min(1).max(14),
});

module.exports = {
  WeatherCurrentSchema,
  WeatherConditionSchema,
  WindCardinalSchema,
  WeatherForecastHourSchema,
  WeatherForecastHourlySchema,
  WeatherForecastDaySchema,
  WeatherForecastDailySchema,
  MoonPhaseSchema,
};
