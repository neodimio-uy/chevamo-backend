/**
 * Adapter para STM Montevideo (IMM) — feed legacy del bondi urbano.
 *
 * Box sanitizador Zod: validamos la respuesta del IMM (`/buses`) o del
 * fallback stm-online (que `index.js` ya normaliza al mismo shape) antes de
 * mapearla al schema canónico Vehicle.
 *
 * Nota: el sanitizador permite los mismos campos que el legacy `BusSchema`
 * pero usa `.optional()` en más lugares para no descartar vehículos parciales
 * — el mapper se encarga de inyectar nulls donde faltan.
 *
 * El feed IMM no expone:
 *   - vehículo físico (license_plate, make, model, capacity, propulsion)
 *   - currentStopSequence / currentStopId / currentStatus
 *   - congestionLevel
 *   - timestamp por vehículo (uso `Date.now()` al cierre del fetch)
 */

const { z } = require("zod");

// ─────────────────────────────────────────────────────────────────────────────
// Box sanitizador Zod — shape conjunto IMM + stm-online normalizado
// ─────────────────────────────────────────────────────────────────────────────

// Bbox amplio Uruguay continental + margen, igual que BusSchema legacy
const URUGUAY_LAT_MIN = -36;
const URUGUAY_LAT_MAX = -29;
const URUGUAY_LNG_MIN = -59;
const URUGUAY_LNG_MAX = -52;

const ImmGeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.array(z.number()).length(2),
}).refine(
  (p) => {
    const [lng, lat] = p.coordinates;
    return (
      Number.isFinite(lng) && Number.isFinite(lat) &&
      lng >= URUGUAY_LNG_MIN && lng <= URUGUAY_LNG_MAX &&
      lat >= URUGUAY_LAT_MIN && lat <= URUGUAY_LAT_MAX
    );
  },
  { message: "Coords fuera de Uruguay" }
);

const ImmStmBusRawSchema = z.object({
  busId:          z.coerce.number().int().min(1).max(10_000_000),
  line:           z.string().trim().min(1).max(15),
  company:        z.string().trim().min(1).max(50),
  destination:    z.string().trim().max(200).nullable().optional(),
  origin:         z.string().trim().max(200).nullable().optional(),
  subline:        z.string().trim().max(200).nullable().optional(),
  speed:          z.number().min(0).max(150).nullable().optional(),
  emissions:      z.string().trim().max(50).nullable().optional(),
  thermalConfort: z.string().trim().max(50).nullable().optional(),
  access:         z.string().trim().max(50).nullable().optional(),
  location:       ImmGeoPointSchema,
  lineVariantId:  z.coerce.number().int().min(1).max(100_000).optional(),
}).passthrough();

const ImmStmBusListRawSchema = z.array(ImmStmBusRawSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Mapper a schema canónico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapea un bus del feed IMM/STM al schema canónico Vamo.
 * @param {object} raw - bus ya validado por ImmStmBusRawSchema
 * @param {object} ctx - { cityId, mode, feedSource }
 */
function mapImmStmBus(raw, ctx) {
  const [lng, lat] = raw.location.coordinates;

  // IMM no expone direction explícita. routeShortName == line para STM.
  return {
    id:         `${ctx.feedSource}:${raw.busId}`,
    feedSource: ctx.feedSource,
    cityId:     ctx.cityId,
    mode:       ctx.mode,
    position: {
      lat,
      lng,
      bearing:   null, // IMM no lo expone
      speed:     (typeof raw.speed === "number") ? raw.speed : null,
      odometerM: null,
      altitudeM: null,
    },
    trip: {
      routeId:        raw.line,
      routeShortName: raw.line,
      tripId:         raw.lineVariantId != null ? String(raw.lineVariantId) : null,
      startTime:      null,
      startDate:      null,
      headsign:       raw.destination || null,
      direction:      null,
    },
    agency: {
      id:   null, // IMM no devuelve código numérico estable, solo nombre
      name: raw.company,
    },
    currentStopSequence: null,
    currentStopId:       null,
    currentStatus:       null,
    congestionLevel:     null,
    enrichment:          null, // IMM no expone vehículo físico
    timestamp:           null, // sobrescrito por mapFeedToVehicles con feedTimestamp común
  };
}

/**
 * Mapea la respuesta completa del feed IMM/STM.
 * Asigna `feedTimestamp` único = Date.now() / 1000, ya que el feed no provee.
 */
function mapFeedToVehicles(rawArray, ctx) {
  const valid = [];
  const rejected = [];
  for (const raw of rawArray) {
    const parsed = ImmStmBusRawSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ raw, reason: parsed.error.issues?.[0]?.message || "schema fail" });
      continue;
    }
    valid.push(mapImmStmBus(parsed.data, ctx));
  }

  const feedTimestamp = Math.floor(Date.now() / 1000);
  for (const v of valid) v.timestamp = feedTimestamp;

  return {
    vehicles:        valid,
    feedTimestamp,
    rejectedCount:   rejected.length,
    sampleRejections: rejected.slice(0, 3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variante suburban — mismo feed normalizado pero filtrando a empresas que
// operan líneas suburbanas/metropolitanas (Mvd → Canelones / San José).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Empresas que operan exclusivamente líneas suburbanas/interdepartamentales
 * dentro del feed STM Mvd (códigos según `EMPRESA_NAMES` en index.js):
 *   - 18 COPSA, 35 CITA, 33 CASANOVA, 29 COIT,
 *   - 32 SAN ANTONIO, 39 ZEBALLOS HERMANOS, 41 RUTAS DEL NORTE.
 * Las urbanas (CUTCSA 50, UCOT 70, COETC 10, COME 20) se filtran fuera —
 * van por el feed Mvd urbano `imm-stm`. La detección es por `bus.company`
 * (nombre normalizado por `fetchBusesFromStmOnline` en index.js).
 */
const SUBURBAN_COMPANIES = new Set([
  "COPSA",
  "CITA",
  "CASANOVA",
  "COIT",
  "SAN ANTONIO",
  "ZEBALLOS HERMANOS",
  "RUTAS DEL NORTE",
]);

function isSuburbanCompany(company) {
  if (!company) return false;
  return SUBURBAN_COMPANIES.has(String(company).trim().toUpperCase());
}

/**
 * Mapea el feed STM filtrando solo buses de empresas suburbanas. El input
 * es el mismo shape `BusSchema` que `mapFeedToVehicles` (output de
 * `fetchBusesFromStmOnline`). Asigna `mode: bus` y service "suburban" al ctx.
 */
function mapSuburbanFeedToVehicles(rawArray, ctx) {
  const filtered = rawArray.filter((b) => isSuburbanCompany(b?.company));
  return mapFeedToVehicles(filtered, ctx);
}

module.exports = {
  ImmStmBusRawSchema,
  ImmStmBusListRawSchema,
  SUBURBAN_COMPANIES,
  isSuburbanCompany,
  mapImmStmBus,
  mapFeedToVehicles,
  mapSuburbanFeedToVehicles,
};
