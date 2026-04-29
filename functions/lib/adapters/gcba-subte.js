/**
 * Adapter para AMBA Subte forecast — `apitransporte.buenosaires.gob.ar/subtes/forecastGTFS`
 *
 * Formato: JSON custom (NO GTFS-RT protobuf). Shape:
 *   {
 *     Header: { timestamp: 1777... },
 *     Entity: [
 *       {
 *         ID: "LineaA_A11",
 *         Linea: {
 *           Trip_Id, Route_Id, Direction_ID, start_time, start_date,
 *           Estaciones: [
 *             { stop_id, stop_name,
 *               arrival:   { time, delay },
 *               departure: { time, delay } }
 *           ]
 *         }
 *       }
 *     ]
 *   }
 *
 * Diferencia clave con feeds normales: NO hay GPS de los vehículos. Solo
 * arrivals predictions por estación. Por eso NO mapea a `TransitVehicle`
 * (que asume position GPS). Devuelve un shape `SubteTripUpdate[]` propio que
 * el cliente iOS consume vía endpoint `/subte-forecast?jurisdictionId=...`.
 *
 * v2 (post-launch): cuando exista catalog estático del Subte, enriquecer
 * cada update con coords de la próxima estación para mostrar "vehículo
 * virtual" en mapa entre paradas.
 */

const axios = require("axios");
const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod
// ─────────────────────────────────────────────────────────────────────────────

const ArrivalSchema = z.object({
  time:  z.number().int().nonnegative(),
  delay: z.number().int().optional().nullable(),
});

const RawEstacionSchema = z.object({
  stop_id:    z.string(),
  stop_name:  z.string(),
  arrival:    ArrivalSchema.optional().nullable(),
  departure:  ArrivalSchema.optional().nullable(),
});

const RawEntitySchema = z.object({
  ID: z.string(),
  Linea: z.object({
    Trip_Id:      z.string(),
    Route_Id:     z.string(),
    Direction_ID: z.number().int().optional().nullable(),
    start_time:   z.string().optional().nullable(),
    start_date:   z.string().optional().nullable(),
    Estaciones:   z.array(RawEstacionSchema).default([]),
  }),
});

const RawForecastSchema = z.object({
  Header: z.object({ timestamp: z.number().int().nonnegative() }).optional(),
  Entity: z.array(RawEntitySchema).default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema canónico de salida (Vamo `SubteTripUpdate`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StopTimeUpdate
 * @property {string} stopId
 * @property {string} stopName
 * @property {number|null} arrivalTime - Unix epoch seconds
 * @property {number|null} arrivalDelaySeconds
 * @property {number|null} departureTime
 * @property {number|null} departureDelaySeconds
 */

/**
 * @typedef {Object} SubteTripUpdate
 * @property {string} id - feed entity ID (ej "LineaA_A11")
 * @property {string} routeId - GTFS route_id
 * @property {string} routeShortName - "A", "B", "C", "D", "E", "H"
 * @property {string} tripId
 * @property {number|null} directionId
 * @property {string|null} startTime
 * @property {string|null} startDate
 * @property {StopTimeUpdate[]} stopTimeUpdates
 * @property {number} feedTimestamp
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + map
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINT = "https://apitransporte.buenosaires.gob.ar/subtes/forecastGTFS";

/**
 * @param {{ clientId: string, clientSecret: string }} opts
 * @returns {Promise<{ tripUpdates: SubteTripUpdate[], feedTimestamp: number, rejectedCount: number }>}
 */
async function fetchSubteForecast({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error("GCBA credentials not configured");
  }
  const url = `${ENDPOINT}?client_id=${clientId}&client_secret=${clientSecret}`;
  // Proxy GCBA: rechaza User-Agent default + flaky en cold-start (500 transients).
  // Retry una vez con delay corto si el primer call falla con 5xx o timeout.
  const reqOpts = {
    timeout: 12_000,
    responseType: "json",
    headers: { "User-Agent": "Vamo/1.0" },
  };
  let r;
  try {
    r = await axios.get(url, reqOpts);
  } catch (e) {
    const status = e.response?.status;
    if (status && status >= 500 && status < 600) {
      await new Promise((res) => setTimeout(res, 1500));
      r = await axios.get(url, reqOpts);
    } else {
      throw e;
    }
  }

  const parsed = RawForecastSchema.safeParse(r.data);
  if (!parsed.success) {
    throw new Error(`Subte forecast schema mismatch: ${parsed.error.message.slice(0, 200)}`);
  }

  const feedTimestamp = parsed.data.Header?.timestamp || Math.floor(Date.now() / 1000);
  const tripUpdates = [];
  let rejectedCount = 0;

  for (const entity of parsed.data.Entity) {
    try {
      const linea = entity.Linea;
      const stopTimeUpdates = linea.Estaciones.map((est) => ({
        stopId:                est.stop_id,
        stopName:              est.stop_name,
        arrivalTime:           est.arrival?.time ?? null,
        arrivalDelaySeconds:   est.arrival?.delay ?? null,
        departureTime:         est.departure?.time ?? null,
        departureDelaySeconds: est.departure?.delay ?? null,
      }));

      // Derivar route_short_name del Route_Id ("LineaA" → "A")
      const routeShortName = linea.Route_Id.replace(/^Linea/i, "").trim();

      tripUpdates.push({
        id:              entity.ID,
        routeId:         linea.Route_Id,
        routeShortName,
        tripId:          linea.Trip_Id,
        directionId:     linea.Direction_ID ?? null,
        startTime:       linea.start_time ?? null,
        startDate:       linea.start_date ?? null,
        stopTimeUpdates,
        feedTimestamp,
      });
    } catch {
      rejectedCount++;
    }
  }

  return { tripUpdates, feedTimestamp, rejectedCount };
}

module.exports = {
  fetchSubteForecast,
  // Exports para testing
  RawForecastSchema,
};
