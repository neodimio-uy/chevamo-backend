/**
 * Adapter Google Maps Platform Weather → shape canónica Vamo.
 *
 * Google devuelve un objeto enorme con ~30 enums de weatherCondition.type
 * y campos con sub-objetos ({degrees, unit}). Este adapter consolida todo
 * en la shape mínima + descripciones en español uruguayo.
 *
 * API de referencia: https://developers.google.com/maps/documentation/weather
 *
 * Todo lo que NO esté acá debe tratarse como "unknown" — mejor fallar seguro
 * que arrastrar un string raro hasta el cliente.
 */

// Mapping Google weatherCondition.type → condición canónica Vamo.
// Fuente: tabla oficial de condiciones de Google Weather API.
const GOOGLE_TO_CANONICAL = {
  // Despejado / soleado
  CLEAR: "clear",
  MOSTLY_CLEAR: "clear",
  SUNNY: "clear",

  // Parcialmente nublado
  PARTLY_CLOUDY: "partly-cloudy",
  MOSTLY_CLOUDY: "partly-cloudy",

  // Nublado completo
  CLOUDY: "cloudy",
  OVERCAST: "cloudy",

  // Lluvia (todas las intensidades caen en "rain" — el mm y prob ya cuentan la historia)
  LIGHT_RAIN: "rain",
  RAIN: "rain",
  HEAVY_RAIN: "rain",
  RAIN_SHOWERS: "rain",
  LIGHT_RAIN_SHOWERS: "rain",
  HEAVY_RAIN_SHOWERS: "rain",
  SCATTERED_SHOWERS: "rain",
  DRIZZLE: "rain",
  LIGHT_TO_MODERATE_RAIN: "rain",
  MODERATE_TO_HEAVY_RAIN: "rain",
  CHANCE_OF_SHOWERS: "rain",
  CHANCE_OF_RAIN: "rain",
  LIGHT_SHOWERS: "rain",
  HEAVY_SHOWERS: "rain",
  RAIN_PERIODIC_HEAVY: "rain",
  FREEZING_RAIN: "rain",
  ISOLATED_SHOWERS: "rain",

  // Tormenta
  THUNDERSTORM: "thunderstorm",
  LIGHT_THUNDERSTORM_RAIN: "thunderstorm",
  SCATTERED_THUNDERSTORMS: "thunderstorm",
  HEAVY_THUNDERSTORM: "thunderstorm",

  // Nieve (rara en Mdvo pero mapeada)
  SNOW: "snow",
  LIGHT_SNOW: "snow",
  HEAVY_SNOW: "snow",
  SNOW_SHOWERS: "snow",
  RAIN_AND_SNOW: "snow",
  SLEET: "snow",

  // Niebla
  FOG: "fog",
  HAZE: "fog",
  MIST: "fog",

  // Viento
  WINDY: "windy",
  WIND_AND_RAIN: "rain",   // si hay lluvia, prioriza rain
};

// Descripción human-readable en es-UY por condición canónica.
const ES_DESCRIPTION = {
  "clear":         "Despejado",
  "partly-cloudy": "Parcialmente nublado",
  "cloudy":        "Nublado",
  "rain":          "Lluvia",
  "thunderstorm":  "Tormenta",
  "snow":          "Nieve",
  "fog":           "Niebla",
  "windy":         "Ventoso",
  "unknown":       "Sin información",
};

/**
 * Convierte una respuesta cruda de Google `currentConditions:lookup` a la
 * shape canónica que consume el cliente.
 *
 * @param {object} raw - respuesta body de Google
 * @returns {object} shape canónica validable por WeatherCurrentSchema
 */
function adaptCurrent(raw) {
  if (!raw || typeof raw !== "object") {
    return fallbackWeather();
  }

  // Google envía { temperature: { degrees, unit } } — extraer el número.
  // unit default "CELSIUS" porque pedimos unitsSystem=METRIC.
  const tempC       = readDegrees(raw.temperature);
  const feelsLikeC  = readDegrees(raw.feelsLikeTemperature);

  const googleType  = raw.weatherCondition?.type || "";
  const conditionInitial = GOOGLE_TO_CANONICAL[googleType] || "unknown";

  // Preferir la descripción de Google si viene (ya localizada por languageCode),
  // sino caer al diccionario local en español.
  const googleDesc  = raw.weatherCondition?.description?.text;

  // precipitation.qpf: quantitative precipitation forecast en mm (últimas 1h)
  const precipitationMm     = readValue(raw.precipitation?.qpf) ?? 0;
  const precipitationProbPct = clampPct(raw.precipitation?.probability?.percent ?? 0);
  const windKmhRaw = readValue(raw.wind?.speed) ?? 0;

  // Si el mapping directo cayó en "unknown" pero la descripción / mm / wind
  // dan señal clara, usamos esa heurística antes de mostrar "Sin información".
  const condition = inferConditionFromSignals(
    conditionInitial, googleDesc, precipitationMm, windKmhRaw
  );
  const description = googleDesc || ES_DESCRIPTION[condition];

  // Wind direction: Google puede mandar `wind.direction.degrees` (0-360, donde
  // 0 = norte, 90 = este…) y/o `wind.direction.cardinal` ("NORTH"/"EAST"…).
  // Mapeamos a 8-cardinal abreviado para UI en español sin localizar.
  const windDir = readDegrees(raw.wind?.direction);
  const windDirectionDeg = windDir != null ? Math.round(windDir) : null;
  const windCardinal = readWindCardinal(raw.wind?.direction?.cardinal, raw.wind?.speed);

  // Gust: ráfaga máxima en la última hora.
  const windGustKmhRaw = readValue(raw.wind?.gust);
  const windGustKmh = windGustKmhRaw != null
    ? Math.max(0, roundOne(windGustKmhRaw))
    : null;

  // Presión: Google manda en hPa (hectopascales). 1013.25 = nivel del mar.
  const pressureHpaRaw = readValue(raw.airPressure?.meanSeaLevelMillibars);
  const pressureHpa = pressureHpaRaw != null
    ? roundOne(pressureHpaRaw)
    : null;

  // Punto de rocío: temperatura a la que el aire se satura. Indica humedad
  // pegajosa en verano (>20°C) o aire seco en invierno (<5°C).
  const dewPointC = readDegrees(raw.dewPoint);

  // Visibilidad: en km típicamente 10-50 con cielo despejado, <2 con niebla.
  const visibilityRaw = readValue(raw.visibility?.distance);
  const visibilityKm = visibilityRaw != null
    ? Math.max(0, roundOne(visibilityRaw))
    : null;

  // Cloud cover 0-100%. Útil para distinguir "clear" vs "partly-cloudy".
  const cloudCoverRaw = raw.cloudCover;
  const cloudCoverPct = (typeof cloudCoverRaw === "number")
    ? clampPct(cloudCoverRaw)
    : null;

  // Sunrise/sunset: NO vienen en currentConditions:lookup — Google los
  // expone en dailyForecast:lookup (endpoint distinto). En B1 quedan null;
  // en B3 (forecast daily) el cliente combinará current + el sunrise/sunset
  // del daily[0] para tener el set completo. Mantener el slot acá facilita
  // que futuras versiones de Google los muevan a current sin romper schema.
  const sunriseISO = null;
  const sunsetISO = null;

  return {
    tempC:               roundOne(tempC ?? 0),
    feelsLikeC:          feelsLikeC != null ? roundOne(feelsLikeC) : null,
    condition,
    description:         (description || "").trim() || ES_DESCRIPTION[condition],
    isDaytime:           raw.isDaytime === true,
    humidityPct:         clampPct(raw.relativeHumidity ?? 0),
    precipitationMm:     Math.max(0, roundOne(precipitationMm)),
    precipitationProbPct: precipitationProbPct,
    windKmh:             Math.max(0, roundOne(windKmhRaw)),
    uvIndex:             clampUv(raw.uvIndex ?? 0),

    windDirectionDeg,
    windCardinal,
    windGustKmh,
    pressureHpa,
    dewPointC: dewPointC != null ? roundOne(dewPointC) : null,
    visibilityKm,
    cloudCoverPct,
    sunriseISO,
    sunsetISO,
  };
}

// MARK: - Helpers

function readDegrees(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.degrees !== "number") return null;
  // unitsSystem=METRIC garantiza Celsius, pero validamos por si acaso
  if (obj.unit && obj.unit !== "CELSIUS") return null;
  return obj.degrees;
}

function readValue(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.value === "number") return obj.value;
  if (typeof obj.quantity === "number") return obj.quantity;
  return null;
}

function roundOne(n) {
  return Math.round(n * 10) / 10;
}

function clampPct(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(100, Math.max(0, v));
}

function clampUv(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(15, Math.max(0, v));
}

function fallbackWeather() {
  return {
    tempC: 0,
    feelsLikeC: null,
    condition: "unknown",
    description: ES_DESCRIPTION["unknown"],
    isDaytime: true,
    humidityPct: 0,
    precipitationMm: 0,
    precipitationProbPct: 0,
    windKmh: 0,
    uvIndex: 0,
    windDirectionDeg: null,
    windCardinal: null,
    windGustKmh: null,
    pressureHpa: null,
    dewPointC: null,
    visibilityKm: null,
    cloudCoverPct: null,
    sunriseISO: null,
    sunsetISO: null,
  };
}

/// Mapea el cardinal de Google ("NORTH", "NORTH_EAST", "EAST"…) al set de 8
/// puntos abreviados que usa el cliente. Si la velocidad del viento es 0 o
/// muy baja (<1 km/h), devolvemos "calm" para que la UI muestre brújula
/// neutra sin flecha.
function readWindCardinal(googleCardinal, windSpeedObj) {
  const speed = readValue(windSpeedObj);
  if (typeof speed === "number" && speed < 1) return "calm";
  if (typeof googleCardinal !== "string") return null;
  const map = {
    "NORTH":             "N",
    "NORTH_NORTHEAST":   "NE",
    "NORTHEAST":         "NE",
    "EAST_NORTHEAST":    "NE",
    "EAST":              "E",
    "EAST_SOUTHEAST":    "SE",
    "SOUTHEAST":         "SE",
    "SOUTH_SOUTHEAST":   "SE",
    "SOUTH":             "S",
    "SOUTH_SOUTHWEST":   "SW",
    "SOUTHWEST":         "SW",
    "WEST_SOUTHWEST":    "SW",
    "WEST":              "W",
    "WEST_NORTHWEST":    "NW",
    "NORTHWEST":         "NW",
    "NORTH_NORTHWEST":   "NW",
  };
  return map[googleCardinal] || null;
}

// MARK: - Forecast hourly (B2)
//
// Google `forecast/hours:lookup` devuelve `forecastHours: [...]` donde cada
// item tiene shape parecida a currentConditions pero con campos extra de
// timing (interval.startTime, interval.endTime, displayDateTime).
// Mapeamos a la shape canónica del schema.

/**
 * Convierte un slot horario de Google (`forecastHours[i]`) a la shape
 * canónica `WeatherForecastHour`.
 */
/**
 * Si Google devuelve un tipo que no está en `GOOGLE_TO_CANONICAL` (caen
 * como "unknown"), inferimos la condición canónica desde otras señales:
 * descripción, mm de precipitación y velocidad del viento. Mantiene
 * "unknown" solo cuando no hay nada que indique algo concreto.
 */
function inferConditionFromSignals(canonical, googleDesc, precipitationMm, windKmh) {
  if (canonical !== "unknown") return canonical;
  const desc = (googleDesc || "").toLowerCase();
  if (desc.includes("chubas") || desc.includes("lluvia") ||
      desc.includes("llovizna") || desc.includes("precip")) {
    return "rain";
  }
  if (desc.includes("tormenta") || desc.includes("eléctric") ||
      desc.includes("electric")) {
    return "thunderstorm";
  }
  if (desc.includes("niebla") || desc.includes("neblina") ||
      desc.includes("bruma")) {
    return "fog";
  }
  if (desc.includes("nublad")) {
    return desc.includes("parc") ? "partly-cloudy" : "cloudy";
  }
  if (desc.includes("despejad") || desc.includes("solead")) {
    return "clear";
  }
  // Sin descripción útil: heurística cuantitativa.
  if (precipitationMm > 0.2) return "rain";
  if (windKmh > 30) return "windy";
  return "unknown";
}

function adaptForecastHour(slot) {
  if (!slot || typeof slot !== "object") return null;

  // Google devuelve `interval.startTime` (ISO con TZ) o `displayDateTime`.
  // Preferimos startTime — es UTC determinístico que el cliente convierte
  // al TZ local con DateFormatter.
  const timeISO = (typeof slot.interval?.startTime === "string")
    ? slot.interval.startTime
    : (typeof slot.displayDateTime?.startTime === "string"
        ? slot.displayDateTime.startTime
        : null);
  if (!timeISO) return null;

  // Hora del día local: lo más simple es parsear el ISO y leer getUTCHours
  // ajustado por offset. Para Mvd (UTC-3) es shift fijo si la TZ está en
  // el ISO. Por simplicidad, leemos `displayDateTime.hours` si Google la
  // manda; sino calculamos del ISO con TZ embebido.
  const hour = (typeof slot.displayDateTime?.hours === "number")
    ? slot.displayDateTime.hours
    : extractHourFromISO(timeISO);

  const tempC      = readDegrees(slot.temperature);
  const feelsLikeC = readDegrees(slot.feelsLikeTemperature);

  const googleType  = slot.weatherCondition?.type || "";
  const conditionInitial = GOOGLE_TO_CANONICAL[googleType] || "unknown";
  const googleDesc  = slot.weatherCondition?.description?.text;

  const precipitationMm     = readValue(slot.precipitation?.qpf) ?? 0;
  const precipitationProbPct = clampPct(slot.precipitation?.probability?.percent ?? 0);
  const windKmhRaw = readValue(slot.wind?.speed) ?? 0;

  const condition = inferConditionFromSignals(
    conditionInitial, googleDesc, precipitationMm, windKmhRaw
  );
  const description = (googleDesc || ES_DESCRIPTION[condition] || "").trim();

  return {
    timeISO,
    hour: clampHour(hour),
    tempC: roundOne(tempC ?? 0),
    feelsLikeC: feelsLikeC != null ? roundOne(feelsLikeC) : null,
    condition,
    description: description || ES_DESCRIPTION[condition],
    isDaytime: slot.isDaytime === true,
    precipitationMm: Math.max(0, roundOne(precipitationMm)),
    precipitationProbPct,
    windKmh: Math.max(0, roundOne(windKmhRaw)),
    windCardinal: readWindCardinal(slot.wind?.direction?.cardinal, slot.wind?.speed),
    humidityPct: typeof slot.relativeHumidity === "number"
      ? clampPct(slot.relativeHumidity) : null,
    uvIndex: typeof slot.uvIndex === "number"
      ? clampUv(slot.uvIndex) : null,
  };
}

/**
 * Mapea la respuesta completa de `forecast/hours:lookup`.
 */
function adaptForecastHourly(raw) {
  if (!raw || !Array.isArray(raw.forecastHours)) return { hours: [] };
  const hours = raw.forecastHours
    .map(adaptForecastHour)
    .filter((h) => h !== null);
  return { hours };
}

// MARK: - Helpers compartidos

function clampHour(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(23, Math.max(0, v));
}

function extractHourFromISO(iso) {
  // El ISO de Google Weather viene con TZ embebido — para `forecast/hours`
  // pedimos coords en Mvd y Google devuelve "T18:00:00-03:00" donde el 18
  // YA es la hora local (no UTC). Por eso alcanza con leer los dos digitos
  // tras la T sin tocar nada más.
  // Si en el futuro Google empieza a devolver "T21:00:00Z" (UTC) habría
  // que convertir, pero hoy no es el caso.
  const match = iso.match(/T(\d{2}):/);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

// MARK: - Forecast daily (B3)
//
// Google `forecast/days:lookup` devuelve `forecastDays: [...]`. Cada día
// tiene `daytimeForecast` y `nighttimeForecast` (con condition, precipita,
// viento) más `maxTemperature`/`minTemperature` agregados, sun/moon events
// y moon phase. Tomamos la condición dominante del día (daytime preferido).

/**
 * Mapeo del enum de fase lunar de Google a strings canónicos.
 * Fuente: campos `moonPhase` / `moonPhaseEnum` típicos de Weather API.
 */
const GOOGLE_MOON_PHASE = {
  NEW_MOON:        "new",
  WAXING_CRESCENT: "waxing-crescent",
  FIRST_QUARTER:   "first-quarter",
  WAXING_GIBBOUS:  "waxing-gibbous",
  FULL_MOON:       "full",
  WANING_GIBBOUS:  "waning-gibbous",
  LAST_QUARTER:    "last-quarter",
  WANING_CRESCENT: "waning-crescent",
};

/**
 * Convierte un slot diario de Google a la shape canónica.
 * Estrategia de "condición dominante": preferimos `daytimeForecast.weatherCondition`
 * porque es lo que el usuario percibe; si no viene, fallback al nighttime.
 */
function adaptForecastDay(slot) {
  if (!slot || typeof slot !== "object") return null;

  // displayDate: { year, month, day } — armamos ISO YYYY-MM-DD.
  const dd = slot.displayDate;
  if (!dd || typeof dd.year !== "number" || typeof dd.month !== "number" ||
      typeof dd.day !== "number") {
    return null;
  }
  const dateISO = `${dd.year.toString().padStart(4, "0")}-${dd.month.toString().padStart(2, "0")}-${dd.day.toString().padStart(2, "0")}`;
  const dayOfWeek = computeDayOfWeek(dd.year, dd.month, dd.day);

  const tempMaxC = readDegrees(slot.maxTemperature);
  const tempMinC = readDegrees(slot.minTemperature);

  // Tomamos daytime como dominante; si no viene, nighttime.
  const dominant = slot.daytimeForecast || slot.nighttimeForecast || {};

  const googleType  = dominant.weatherCondition?.type || "";
  const conditionInitial = GOOGLE_TO_CANONICAL[googleType] || "unknown";
  const googleDesc  = dominant.weatherCondition?.description?.text;

  const precipitationMm =
    (readValue(slot.daytimeForecast?.precipitation?.qpf) ?? 0) +
    (readValue(slot.nighttimeForecast?.precipitation?.qpf) ?? 0);
  // Probabilidad: tomamos el máximo entre día y noche — más útil que sumar.
  const probDay = clampPct(slot.daytimeForecast?.precipitation?.probability?.percent ?? 0);
  const probNight = clampPct(slot.nighttimeForecast?.precipitation?.probability?.percent ?? 0);
  const precipitationProbPct = Math.max(probDay, probNight);

  // Viento: tomar máximo del día (más relevante que promedio).
  const windDayKmh = readValue(slot.daytimeForecast?.wind?.speed) ?? 0;
  const windNightKmh = readValue(slot.nighttimeForecast?.wind?.speed) ?? 0;
  const windKmh = Math.max(windDayKmh, windNightKmh);
  const windCardinal = readWindCardinal(
    dominant.wind?.direction?.cardinal,
    dominant.wind?.speed
  );

  const condition = inferConditionFromSignals(
    conditionInitial, googleDesc, precipitationMm, windKmh
  );
  const description = (googleDesc || ES_DESCRIPTION[condition] || "").trim();

  // Sun/moon events
  const sunriseISO = (typeof slot.sunEvents?.sunriseTime === "string")
    ? slot.sunEvents.sunriseTime : null;
  const sunsetISO = (typeof slot.sunEvents?.sunsetTime === "string")
    ? slot.sunEvents.sunsetTime : null;
  const moonriseISO = (typeof slot.moonEvents?.moonriseTimes?.[0] === "string")
    ? slot.moonEvents.moonriseTimes[0] : null;
  const moonsetISO = (typeof slot.moonEvents?.moonsetTimes?.[0] === "string")
    ? slot.moonEvents.moonsetTimes[0] : null;
  const moonPhaseRaw = slot.moonEvents?.moonPhase ||
                      slot.moonEvents?.moonPhaseEnum;
  const moonPhase = (typeof moonPhaseRaw === "string")
    ? (GOOGLE_MOON_PHASE[moonPhaseRaw] || null) : null;

  // UV index: max en el día. Google a veces lo manda en daytimeForecast.uvIndex.
  const uvDay = (typeof slot.daytimeForecast?.uvIndex === "number")
    ? slot.daytimeForecast.uvIndex : (typeof slot.uvIndex === "number" ? slot.uvIndex : 0);

  // Humedad promedio del día — opcional, Google puede no mandarla.
  const humidityDay = slot.daytimeForecast?.relativeHumidity;
  const humidityAvgPct = typeof humidityDay === "number" ? clampPct(humidityDay) : null;

  return {
    dateISO,
    dayOfWeek,
    tempMaxC: roundOne(tempMaxC ?? 0),
    tempMinC: roundOne(tempMinC ?? 0),
    condition,
    description: description || ES_DESCRIPTION[condition],
    precipitationMm: Math.max(0, roundOne(precipitationMm)),
    precipitationProbPct,
    windKmh: Math.max(0, roundOne(windKmh)),
    windCardinal,
    uvIndexMax: clampUv(uvDay),
    humidityAvgPct,
    sunriseISO,
    sunsetISO,
    moonriseISO,
    moonsetISO,
    moonPhase,
  };
}

function adaptForecastDaily(raw) {
  if (!raw || !Array.isArray(raw.forecastDays)) return { days: [] };
  const days = raw.forecastDays
    .map(adaptForecastDay)
    .filter((d) => d !== null);
  return { days };
}

/**
 * Day-of-week: 1=lunes..7=domingo (ISO 8601). Usamos el algoritmo de Zeller
 * para no depender de TZ del runtime — Google manda displayDate en hora
 * local del location, y queremos el día calendario de esa fecha tal cual.
 */
function computeDayOfWeek(year, month, day) {
  // JS Date.getUTCDay devuelve 0=domingo..6=sábado.
  const date = new Date(Date.UTC(year, month - 1, day));
  const jsDay = date.getUTCDay();         // 0..6
  return jsDay === 0 ? 7 : jsDay;          // 1..7 (lun..dom)
}

module.exports = {
  adaptCurrent,
  adaptForecastHour,
  adaptForecastHourly,
  adaptForecastDay,
  adaptForecastDaily,
  GOOGLE_TO_CANONICAL,
  ES_DESCRIPTION,
};
