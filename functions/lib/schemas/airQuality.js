/**
 * Schema canónico de calidad del aire actual.
 * Fuente: Google Air Quality API (`currentConditions:lookup`).
 * Cliente iOS: struct `AirQuality` en `Weather.swift`.
 *
 * El AQI universal de Google ("UAQI") es 0-100 inverso (100 = excelente,
 * 0 = peligroso). El AQI local de cada país (ej: AQI EPA US, EAQI europeo)
 * se reporta como `localAqi` opcional. El cliente prefiere mostrar UAQI
 * para consistencia entre países pero podrá mostrar el local si está.
 */

const { z } = require("zod");

// Categorías canónicas de calidad del aire — colapsa los 6 niveles típicos
// del UAQI a 5 buckets fáciles de pintar con un color cada uno.
const AirQualityCategorySchema = z.enum([
  "excellent",   // UAQI 80-100 / EPA 0-50
  "good",        // UAQI 60-80  / EPA 51-100
  "moderate",    // UAQI 40-60  / EPA 101-150
  "unhealthy",   // UAQI 20-40  / EPA 151-200
  "hazardous",   // UAQI 0-20   / EPA 201+
  "unknown",
]);

// Pollutants individuales — los más comunes que reporta Google.
// El cliente puede mostrar tabla "PM2.5: 12 µg/m³ (bueno)".
const PollutantSchema = z.object({
  code:        z.string(),       // "pm25" | "pm10" | "no2" | "o3" | "so2" | "co"
  displayName: z.string(),       // "PM2.5"
  fullName:    z.string(),       // "Partículas finas inhalables"
  concentration: z.number().nonnegative(),
  unit:        z.string(),       // "MICROGRAMS_PER_CUBIC_METER" | "PARTS_PER_BILLION"
});

const AirQualityCurrentSchema = z.object({
  // AQI universal de Google (0-100 inverso, 100 = mejor).
  uaqi:           z.number().int().min(0).max(100),
  category:       AirQualityCategorySchema,
  /// Descripción human-readable en español ("Calidad del aire buena").
  description:    z.string(),
  /// Color hex sugerido por Google (ej "#27ae60") para painting consistente.
  hexColor:       z.string().nullable().optional(),
  /// Recomendación corta de salud para el momento (es-419).
  healthRecommendation: z.string().nullable().optional(),
  /// AQI local del país de la coord (UY no tiene índice oficial, pero
  /// Google puede caer al EPA US como fallback). Opcional.
  localAqi:       z.number().int().min(0).max(500).nullable().optional(),
  localAqiName:   z.string().nullable().optional(),  // ej "EPA NowCast"
  /// Lista detallada de contaminantes — opcional, no todos los lugares la traen.
  pollutants:     z.array(PollutantSchema).nullable().optional(),
});

module.exports = {
  AirQualityCurrentSchema,
  AirQualityCategorySchema,
  PollutantSchema,
};
