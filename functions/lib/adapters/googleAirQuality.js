/**
 * Adapter Google Air Quality API → shape canónica Vamo.
 *
 * Endpoint: POST https://airquality.googleapis.com/v1/currentConditions:lookup
 * Docs: https://developers.google.com/maps/documentation/air-quality
 *
 * Devuelve un objeto con `indexes` (AQI universal + locales) y opcionalmente
 * `pollutants` (PM2.5, NO2, etc) y `healthRecommendations`. Consolidamos
 * en una shape compacta que el cliente pinta como "card de calidad del aire"
 * en la pestaña Clima.
 */

// El AQI universal de Google ("uaqi") es 0-100 INVERSO: 100 = excelente,
// 0 = peligroso. Mapeamos a buckets canónicos para la UI.
function categoryFromUAQI(uaqi) {
  if (typeof uaqi !== "number") return "unknown";
  if (uaqi >= 80) return "excellent";
  if (uaqi >= 60) return "good";
  if (uaqi >= 40) return "moderate";
  if (uaqi >= 20) return "unhealthy";
  return "hazardous";
}

const ES_AQI_DESCRIPTION = {
  excellent: "Calidad del aire excelente",
  good:      "Calidad del aire buena",
  moderate:  "Calidad del aire moderada",
  unhealthy: "Calidad del aire baja",
  hazardous: "Calidad del aire peligrosa",
  unknown:   "Sin información de calidad del aire",
};

// Mapping pollutant code (Google: "pm25" | "pm10" | "no2" | "o3" | "so2" | "co")
// a nombre completo en español para tooltip.
const ES_POLLUTANT_FULL_NAME = {
  pm25: "Partículas finas (PM2.5)",
  pm10: "Partículas inhalables (PM10)",
  no2:  "Dióxido de nitrógeno",
  o3:   "Ozono",
  so2:  "Dióxido de azufre",
  co:   "Monóxido de carbono",
};

/**
 * Convierte la respuesta cruda de Google Air Quality a la shape canónica.
 */
function adaptCurrentConditions(raw) {
  if (!raw || typeof raw !== "object") {
    return fallbackAQI();
  }

  // Google manda `indexes: [...]` ordenado típicamente con UAQI primero.
  // Buscamos por code para no depender del orden.
  const indexes = Array.isArray(raw.indexes) ? raw.indexes : [];
  const uaqiEntry = indexes.find((i) => i.code === "uaqi") || indexes[0];

  if (!uaqiEntry || typeof uaqiEntry.aqi !== "number") {
    return fallbackAQI();
  }

  const uaqi = clamp100(uaqiEntry.aqi);
  const category = categoryFromUAQI(uaqi);

  // Display name en español si Google lo manda; sino diccionario local.
  const displayName = uaqiEntry.category || ES_AQI_DESCRIPTION[category];

  // Color hex que Google sugiere para painting (#RRGGBB sin alpha).
  const hexColor = (typeof uaqiEntry.color === "object" && uaqiEntry.color)
    ? rgbToHex(uaqiEntry.color)
    : null;

  // Local AQI: cualquier index que NO sea uaqi. Para Uruguay Google a veces
  // cae al EPA US como fallback. Si no hay, queda null.
  const localEntry = indexes.find((i) => i.code !== "uaqi");
  const localAqi = (localEntry && typeof localEntry.aqi === "number")
    ? Math.round(localEntry.aqi) : null;
  const localAqiName = localEntry?.displayName || localEntry?.code || null;

  // Health recommendations: Google manda un objeto con keys por audiencia
  // (general, elderly, children, etc). Tomamos `generalPopulation` para
  // mantener la card compacta.
  const healthRecommendation = (typeof raw.healthRecommendations === "object")
    ? (raw.healthRecommendations.generalPopulation || null)
    : null;

  // Pollutants — opcional, los tomamos si están y los normalizamos.
  const rawPollutants = Array.isArray(raw.pollutants) ? raw.pollutants : [];
  const pollutants = rawPollutants
    .map(adaptPollutant)
    .filter((p) => p !== null);

  return {
    uaqi,
    category,
    description: displayName,
    hexColor,
    healthRecommendation,
    localAqi,
    localAqiName,
    pollutants: pollutants.length > 0 ? pollutants : null,
  };
}

function adaptPollutant(p) {
  if (!p || typeof p !== "object") return null;
  const code = (p.code || "").toLowerCase();
  if (!code) return null;
  const conc = p.concentration?.value;
  if (typeof conc !== "number") return null;
  return {
    code,
    displayName: p.displayName || code.toUpperCase(),
    fullName: ES_POLLUTANT_FULL_NAME[code] || p.fullName || p.displayName || code,
    concentration: roundTwo(conc),
    unit: p.concentration?.units || "MICROGRAMS_PER_CUBIC_METER",
  };
}

function fallbackAQI() {
  return {
    uaqi: 0,
    category: "unknown",
    description: ES_AQI_DESCRIPTION.unknown,
    hexColor: null,
    healthRecommendation: null,
    localAqi: null,
    localAqiName: null,
    pollutants: null,
  };
}

function clamp100(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(100, Math.max(0, v));
}

function roundTwo(n) {
  return Math.round(n * 100) / 100;
}

function rgbToHex(c) {
  const r = clamp255((c.red ?? 0) * 255);
  const g = clamp255((c.green ?? 0) * 255);
  const b = clamp255((c.blue ?? 0) * 255);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function clamp255(n) {
  return Math.min(255, Math.max(0, Math.round(n)));
}

module.exports = {
  adaptCurrentConditions,
  ES_AQI_DESCRIPTION,
  ES_POLLUTANT_FULL_NAME,
  categoryFromUAQI,
};
