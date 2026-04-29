/**
 * Compositor que une las 4 capas del modelo nuevo:
 *   - Jurisdiction (administrativa)
 *   - MetroArea (composición funcional)
 *   - NationalNetwork (overlay nacional)
 *   - Operator (organismo que aporta datos)
 *
 * Resuelve queries útiles que cruzan las 4 capas, ej:
 *   - "qué modos están disponibles en CABA cruzando todos los organismos"
 *   - "qué feeds RT alimentan Mvd para bus suburbano"
 *   - "qué networks nacionales sirven a Madrid"
 *
 * Es la fachada que consumen los endpoints HTTP — los archivos individuales
 * (jurisdictions.js, etc.) son catálogos puros sin lógica cross-layer.
 *
 * Patrón: todas las funciones devuelven shapes serializables (JSON-safe).
 * Ningún Map o Set en outputs — cliente iOS lee Codable.
 */

const { JURISDICTIONS, getJurisdiction, detectJurisdiction } = require("./jurisdictions");
const { METRO_AREAS, getMetroArea, getMetroAreasForJurisdiction } = require("./metro-areas");
const { NATIONAL_NETWORKS, getNetworksForJurisdiction } = require("./national-networks");
const { OPERATORS, getOperatorsForJurisdiction } = require("./operators");

/**
 * Resuelve el contexto completo de una jurisdicción:
 *   - la juri en sí
 *   - metroAreas a las que pertenece
 *   - nationalNetworks que la sirven
 *   - operators que la cubren (directos + vía metroArea/network)
 *   - modes derivados (deduped) con sus feeds activos
 *
 * @param {string} jurisdictionId
 * @returns {object|null}
 */
function resolveJurisdiction(jurisdictionId) {
  const jurisdiction = getJurisdiction(jurisdictionId);
  if (!jurisdiction) return null;

  const metroAreas = getMetroAreasForJurisdiction(jurisdictionId);
  const nationalNetworks = getNetworksForJurisdiction(jurisdictionId);

  const metroAreaIds = metroAreas.map((m) => m.id);
  const networkIds = nationalNetworks.map((n) => n.id);

  const operators = getOperatorsForJurisdiction(jurisdictionId, {
    metroAreas: metroAreaIds,
    nationalNetworks: networkIds,
  });

  // Filtra feeds del operator que NO aplican a esta juri (cuando feed.coverage
  // override tiene una whitelist más estrecha). Ej: IMM bus.urban tiene coverage
  // propio = solo `uy.mvd`, no aplica a Canelones aunque IMM cubra el metroArea.
  const ctx = { jurisdictionId, metroAreaIds, networkIds };
  const operatorsScoped = operators
    .map((op) => ({ ...op, feeds: op.feeds.filter((f) => feedAppliesToJurisdiction(f, op, ctx)) }))
    .filter((op) => op.feeds.length > 0);

  const modes = deriveModes(operatorsScoped);

  return {
    jurisdiction,
    metroAreas,
    nationalNetworks,
    operators: operatorsScoped,
    modes,
  };
}

/**
 * Evalúa si un feed concreto aplica a una jurisdicción dado el contexto
 * (la juri target + sus metroAreas + sus nationalNetworks).
 *
 * Si el feed declara `feed.coverage`, ese override ganan — el feed solo aplica
 * si la juri/metro/network está incluido. Si no declara, hereda del operator
 * (asume que ya pasó el filtro de operator coverage en `getOperatorsForJurisdiction`).
 */
function feedAppliesToJurisdiction(feed, operator, ctx) {
  if (!feed.coverage) return true; // hereda del operator
  const c = feed.coverage;
  if (c.jurisdictions?.includes(ctx.jurisdictionId)) return true;
  if (c.metroAreas?.some((ma) => ctx.metroAreaIds.includes(ma))) return true;
  if (c.nationalNetworks?.some((nn) => ctx.networkIds.includes(nn))) return true;
  return false;
}

/**
 * Resuelve un MetroArea en su forma expandida — incluye jurisdicciones
 * miembros, operators que lo cubren, y modos disponibles agregados.
 */
function resolveMetroArea(metroAreaId) {
  const metroArea = getMetroArea(metroAreaId);
  if (!metroArea) return null;

  const jurisdictions = metroArea.jurisdictionIds
    .map((jid) => getJurisdiction(jid))
    .filter(Boolean);

  // Operators que cubren AL MENOS UNA juri del metroArea o el metroArea entero
  const operators = OPERATORS.filter((op) => {
    if (op.coverage.metroAreas?.includes(metroAreaId)) return true;
    return metroArea.jurisdictionIds.some((jid) =>
      op.coverage.jurisdictions?.includes(jid)
    );
  });

  const modes = deriveModes(operators);

  return {
    metroArea,
    jurisdictions,
    operators,
    modes,
  };
}

/**
 * Detecta jurisdicción + contexto completo desde un par de coordenadas.
 * Útil para onboarding ("¿Dónde vivís?" + GPS) y JurisdictionMonitor (Fase 3).
 */
function resolveLocation(lat, lng) {
  const jurisdiction = detectJurisdiction(lat, lng);
  if (!jurisdiction) return null;
  return resolveJurisdiction(jurisdiction.id);
}

/**
 * Cruza los feeds de todos los operators para producir una lista deduped
 * de (mode, service, dataMode) con metadata de qué operators contribuyen.
 *
 * Ej salida para CABA (con gcba como único operator hoy):
 *   [
 *     { mode: "bus",   service: "urban", dataMode: "official", operators: ["gcba"] },
 *     { mode: "subte", service: "urban", dataMode: "official", operators: ["gcba"] },
 *     { mode: "bike",  service: "urban", dataMode: "official", operators: ["gcba"] },
 *   ]
 *
 * Si un mode tiene varios operators (ej Madrid bus = EMT + CRTM), aparece una
 * sola entry con `operators: ["emt-madrid", "crtm"]` y dataMode resuelto:
 *   - si AL MENOS uno es `official` → official (live RT disponible)
 *   - sino, si AL MENOS uno es `staticOnly` → staticOnly (paradas + recorridos)
 *   - sino, `communityOnly`
 */
function deriveModes(operators) {
  const map = new Map(); // key: `${mode}|${service||""}` → entry

  for (const op of operators) {
    for (const feed of op.feeds) {
      const key = `${feed.mode}|${feed.service || ""}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          mode: feed.mode,
          service: feed.service || null,
          dataMode: feed.dataMode,
          operators: [op.id],
          feedAdapterIds: feed.adapterId ? [feed.adapterId] : [],
          staticFeedIds: feed.staticFeedId ? [feed.staticFeedId] : [],
        });
      } else {
        if (!existing.operators.includes(op.id)) existing.operators.push(op.id);
        if (feed.adapterId && !existing.feedAdapterIds.includes(feed.adapterId)) {
          existing.feedAdapterIds.push(feed.adapterId);
        }
        if (feed.staticFeedId && !existing.staticFeedIds.includes(feed.staticFeedId)) {
          existing.staticFeedIds.push(feed.staticFeedId);
        }
        existing.dataMode = mergeDataModes(existing.dataMode, feed.dataMode);
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Merge dos dataModes: el "mejor" gana.
 *   official > staticOnly > communityOnly
 */
function mergeDataModes(a, b) {
  const rank = { official: 3, hybrid: 3, staticOnly: 2, communityOnly: 1 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

/**
 * Devuelve los feeds activos (con adapterId no-null) para una jurisdicción
 * en un modo específico. Útil para `/vehicles?jurisdictionId=X&mode=bus`.
 */
function getActiveFeedsForJurisdictionMode(jurisdictionId, mode, service = null) {
  const ctx = resolveJurisdiction(jurisdictionId);
  if (!ctx) return [];

  const out = [];
  for (const op of ctx.operators) {
    for (const feed of op.feeds) {
      if (feed.mode !== mode) continue;
      if (service !== null && feed.service !== service) continue;
      if (!feed.adapterId) continue; // solo feeds con RT adapter
      out.push({ operatorId: op.id, ...feed });
    }
  }
  return out;
}

module.exports = {
  resolveJurisdiction,
  resolveMetroArea,
  resolveLocation,
  deriveModes,
  getActiveFeedsForJurisdictionMode,
};
