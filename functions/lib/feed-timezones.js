/**
 * Resolución de timezone para feeds estáticos.
 *
 * Cada `STATIC_FEED` tiene `cityIds: [...]`. Cada `CITY` tiene
 * `timezone: "America/Montevideo"` (IANA tz). Este módulo resuelve la
 * timezone "primaria" del feed (la del primer cityId que tenga tz definido).
 *
 * Usado por:
 *   - `nightlyGtfsBatch` para decidir cuándo procesar cada feed
 *     (cuando es "noche" en su ciudad: hora local entre 02:00 y 03:59)
 *   - `runStaticGtfsPipeline` para escribir snapshots en path con date local
 *     (`gtfs-snapshots/{feedId}/2026-04-29/...` donde el date es de la ciudad)
 */

const cityRegistry = require("./cities");
const staticFeeds = require("./static-feeds");

/**
 * Devuelve la TZ IANA primaria del feed.
 * @param {string} feedId
 * @returns {string|null} ej "America/Montevideo", o null si no se resuelve
 */
function timezoneForFeed(feedId) {
  const feed = staticFeeds.getStaticFeed(feedId);
  if (!feed) return null;

  for (const cityId of feed.cityIds || []) {
    // cityIds vienen como "uy.mvd-area-metro" → ["uy", "mvd-area-metro"]
    const dotIdx = cityId.indexOf(".");
    if (dotIdx < 0) continue;
    const country = cityId.slice(0, dotIdx);
    const zone = cityId.slice(dotIdx + 1);
    const city = cityRegistry.getCity(country, zone);
    if (city && city.timezone) return city.timezone;
  }
  return null;
}

/**
 * Devuelve hora local en la TZ del feed.
 * @param {string} feedId
 * @param {Date} [now=new Date()]
 * @returns {{ hour: number, minute: number, dateLocal: string, tz: string }|null}
 *   dateLocal en formato "YYYY-MM-DD" en la TZ de la ciudad.
 *   null si no se pudo resolver TZ.
 */
function localTimeForFeed(feedId, now = new Date()) {
  const tz = timezoneForFeed(feedId);
  if (!tz) return null;

  // Intl.DateTimeFormat con timeZone es la forma estándar Node 20+ de obtener
  // hora local sin librerías externas. parts() devuelve cada componente.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone:  tz,
    year:      "numeric",
    month:     "2-digit",
    day:       "2-digit",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  );

  // en-CA produce ISO-like: "2026-04-29, 03:42"
  const dateLocal = `${parts.year}-${parts.month}-${parts.day}`;
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;          // edge en Intl con hour12:false
  const minute = parseInt(parts.minute, 10);
  return { hour, minute, dateLocal, tz };
}

/**
 * ¿Es "noche" en la ciudad del feed? Ventana 02:00-03:59 local.
 * Window angosta (2h) para que un orquestador hourly tenga 2 oportunidades de
 * disparar (idempotencia se encarga de no duplicar).
 */
function isNightlyWindow(feedId, now = new Date()) {
  const local = localTimeForFeed(feedId, now);
  if (!local) return false;
  return local.hour >= 2 && local.hour < 4;
}

module.exports = {
  timezoneForFeed,
  localTimeForFeed,
  isNightlyWindow,
};
