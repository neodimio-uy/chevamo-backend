/**
 * Canonical busUid — identificador único de bus físico cross-empresa.
 *
 * Cada cooperativa Mvd (CUTCSA, COETC, UCOT, COME) numera sus buses
 * independiente: busId=63 puede ser 3+ buses físicos distintos (uno
 * por empresa). En el feed live verificado 2026-05-26, 203 de 825
 * busIds colisionan cross-empresa.
 *
 * Formato: `${feedSource}:${company}:${busId}:${lineVariantId}`
 *
 * Ejemplos:
 *   imm-stm:CUTCSA:63:4304
 *   imm-stm:UCOT:63:4859     (mismo busId, otra empresa, otro bus físico)
 *   imm-stm:COETC:63:8802
 *   sbase:SBASE:42:1         (futuro subte BA)
 *
 * Por qué cada componente:
 *   - feedSource: multi-ciudad ready (Mvd/BA/futuros)
 *   - company:    resuelve la colisión cross-empresa
 *   - busId:      identidad dentro de la empresa
 *   - lineVariantId: bus que cambia línea mid-day → entidad nueva →
 *                    stabilizer state resetea, predicciones no se cruzan
 *
 * Memoria: feedback_canonical_bus_uid.md
 */

const DEFAULT_FEED = "imm-stm";
const NA = "NA";

/**
 * Computa el busUid canónico. Acepta el bus en cualquiera de los shapes
 * que circulan en el codebase:
 *   - Raw IMM mapped:   { company, busId, lineVariantId }
 *   - Canonical Vehicle: { feedSource, agency.name, busId, trip.tripId }
 *   - UpcomingBus:       { companyName|company, busId, lineVariantId }
 *
 * Si ya viene un `busUid` precomputado, lo devuelve tal cual.
 *
 * @param {object} bus
 * @param {string} [overrideFeed] - fuerza feedSource (ej cuando el mapper sabe)
 * @returns {string|null} busUid canónico, o null si no se puede componer
 */
function computeBusUid(bus, overrideFeed) {
  if (!bus || typeof bus !== "object") return null;
  if (typeof bus.busUid === "string" && bus.busUid.length > 0) return bus.busUid;

  const feedSource = String(
    overrideFeed || bus.feedSource || DEFAULT_FEED
  ).trim() || DEFAULT_FEED;

  const rawCompany = bus.company ?? bus.companyName ?? bus.agency?.name ?? bus.trip?.agencyName;
  const company = (rawCompany ? String(rawCompany).trim().toUpperCase() : "") || NA;

  // busId puede venir como Int, String, o con prefijo viejo ("imm-stm:NNN").
  // Extraer solo la parte numérica final.
  const rawBusId = bus.busId ?? bus.id ?? bus.code;
  if (rawBusId == null || rawBusId === "") return null;
  const busIdStr = String(rawBusId);
  const busId = busIdStr.includes(":") ? busIdStr.split(":").pop() : busIdStr;
  if (!busId) return null;

  const variantRaw = bus.lineVariantId ?? bus.trip?.tripId;
  const variant = variantRaw != null && variantRaw !== "" ? String(variantRaw) : NA;

  return `${feedSource}:${company}:${busId}:${variant}`;
}

/**
 * Parsea un busUid de vuelta a sus componentes. Útil para debugging
 * y queries BQ que necesiten descomponer.
 *
 * @param {string} busUid
 * @returns {{feedSource: string, company: string, busId: string, lineVariantId: string} | null}
 */
function parseBusUid(busUid) {
  if (typeof busUid !== "string") return null;
  const parts = busUid.split(":");
  if (parts.length !== 4) return null;
  return {
    feedSource:    parts[0],
    company:       parts[1],
    busId:         parts[2],
    lineVariantId: parts[3],
  };
}

module.exports = {
  computeBusUid,
  parseBusUid,
  DEFAULT_FEED,
};
