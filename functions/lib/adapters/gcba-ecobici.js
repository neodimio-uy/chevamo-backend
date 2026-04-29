/**
 * Adapter para AMBA Ecobici GBFS — `apitransporte.buenosaires.gob.ar/ecobici/gbfs/*`
 *
 * Formato: GBFS v2.x (estándar de bici-compartida). Endpoints relevantes:
 *   - `stationInformation`: geometría estática (lat/lng, capacity, address)
 *   - `stationStatus`: estado live (num_bikes_available, num_docks_available)
 *
 * Ecobici NO son vehículos en movimiento — son estaciones de docking. Por eso
 * NO mapea a `TransitVehicle` (que asume position GPS de un vehículo). Devuelve
 * un shape `BikeStation[]` propio que el cliente iOS consume vía endpoint
 * `/bike-stations?jurisdictionId=...`.
 *
 * Diseño: combinamos `stationInformation` (poco volátil, cache largo) +
 * `stationStatus` (live, cache corto) en un único objeto por estación.
 */

const axios = require("axios");
const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod
// ─────────────────────────────────────────────────────────────────────────────

const RawStationInfoSchema = z.object({
  station_id:   z.string(),
  name:         z.string(),
  lat:          z.number(),
  lon:          z.number(),
  address:      z.string().optional().nullable(),
  capacity:     z.number().int().nonnegative().optional().nullable(),
  is_charging_station: z.boolean().optional().nullable(),
});

const RawStationStatusSchema = z.object({
  station_id:               z.string(),
  num_bikes_available:      z.number().int().nonnegative().optional().nullable(),
  num_docks_available:      z.number().int().nonnegative().optional().nullable(),
  is_installed:             z.union([z.boolean(), z.number()]).optional().nullable(),
  is_renting:               z.union([z.boolean(), z.number()]).optional().nullable(),
  is_returning:             z.union([z.boolean(), z.number()]).optional().nullable(),
  last_reported:            z.number().int().nonnegative().optional().nullable(),
});

const InfoResponseSchema = z.object({
  last_updated: z.number().int().nonnegative(),
  data: z.object({ stations: z.array(RawStationInfoSchema).default([]) }),
});

const StatusResponseSchema = z.object({
  last_updated: z.number().int().nonnegative(),
  data: z.object({ stations: z.array(RawStationStatusSchema).default([]) }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema canónico de salida (Vamo `BikeStation`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BikeStation
 * @property {string} id - station_id
 * @property {string} systemId - "ecobici-amba"
 * @property {string} name
 * @property {number} lat
 * @property {number} lng
 * @property {string|null} address
 * @property {number|null} capacity
 * @property {boolean} isChargingStation
 * @property {number|null} bikesAvailable
 * @property {number|null} docksAvailable
 * @property {boolean|null} isInstalled
 * @property {boolean|null} isRenting
 * @property {boolean|null} isReturning
 * @property {number|null} lastReportedTimestamp
 */

const ENDPOINT_INFO   = "https://apitransporte.buenosaires.gob.ar/ecobici/gbfs/stationInformation";
const ENDPOINT_STATUS = "https://apitransporte.buenosaires.gob.ar/ecobici/gbfs/stationStatus";

/**
 * @param {{ clientId: string, clientSecret: string }} opts
 * @returns {Promise<{ stations: BikeStation[], feedTimestamp: number, rejectedCount: number }>}
 */
async function fetchEcobiciStations({ clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error("GCBA credentials not configured");
  }
  const auth = `client_id=${clientId}&client_secret=${clientSecret}`;

  // Fetch info + status en paralelo. Si status falla (proxy SSL flaky),
  // seguimos con solo info (estación sin estado de bicis disponibles).
  // Proxy GCBA: User-Agent explícito + retry una vez en 5xx (cold-start flaky).
  const reqOpts = { timeout: 12_000, responseType: "json", headers: { "User-Agent": "Vamo/1.0" } };
  const fetchWithRetry = async (url) => {
    try {
      return await axios.get(url, reqOpts);
    } catch (e) {
      const status = e.response?.status;
      if (status && status >= 500 && status < 600) {
        await new Promise((res) => setTimeout(res, 1500));
        return await axios.get(url, reqOpts);
      }
      throw e;
    }
  };
  const [infoR, statusR] = await Promise.allSettled([
    fetchWithRetry(`${ENDPOINT_INFO}?${auth}`),
    fetchWithRetry(`${ENDPOINT_STATUS}?${auth}`),
  ]);

  if (infoR.status === "rejected") {
    throw new Error(`Ecobici stationInformation fetch failed: ${infoR.reason?.message}`);
  }

  const infoParsed = InfoResponseSchema.safeParse(infoR.value.data);
  if (!infoParsed.success) {
    throw new Error(`Ecobici stationInformation schema mismatch: ${infoParsed.error.message.slice(0, 200)}`);
  }

  // Status puede haber fallado — usamos vacío como fallback
  let statusByStationId = new Map();
  if (statusR.status === "fulfilled") {
    const statusParsed = StatusResponseSchema.safeParse(statusR.value.data);
    if (statusParsed.success) {
      for (const s of statusParsed.data.data.stations) {
        statusByStationId.set(s.station_id, s);
      }
    }
  }

  const stations = [];
  let rejectedCount = 0;

  for (const info of infoParsed.data.data.stations) {
    try {
      const status = statusByStationId.get(info.station_id);
      stations.push({
        id:                    info.station_id,
        systemId:              "ecobici-amba",
        name:                  info.name,
        lat:                   info.lat,
        lng:                   info.lon,
        address:               info.address ?? null,
        capacity:              info.capacity ?? null,
        isChargingStation:     info.is_charging_station === true,
        bikesAvailable:        status?.num_bikes_available ?? null,
        docksAvailable:        status?.num_docks_available ?? null,
        isInstalled:           coerceBool(status?.is_installed),
        isRenting:             coerceBool(status?.is_renting),
        isReturning:           coerceBool(status?.is_returning),
        lastReportedTimestamp: status?.last_reported ?? null,
      });
    } catch {
      rejectedCount++;
    }
  }

  return {
    stations,
    feedTimestamp: infoParsed.data.last_updated,
    rejectedCount,
  };
}

function coerceBool(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number")  return v !== 0;
  return null;
}

module.exports = {
  fetchEcobiciStations,
  // Exports para testing
  InfoResponseSchema,
  StatusResponseSchema,
};
