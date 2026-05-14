/**
 * Catálogo de Operators (organismos que aportan datos a Vamo).
 *
 * Un Operator es la entidad que publica un feed (RT o estático). Una jurisdicción
 * puede tener varios operators contribuyendo. Un mismo operator puede dar datos
 * a varias jurisdicciones.
 *
 * Cada entry define:
 *   - id: identificador único snake-kebab (`imm`, `gcba`, etc.)
 *   - displayName: nombre humano (puede tener variantes locales en futuro)
 *   - country: ISO2 (donde tiene sede / opera principal)
 *   - kind: `public-agency` | `concession` | `private-operator` | `data-aggregator`
 *   - feeds: lista de feeds que publica (cada uno con mode + dataMode + adapter id)
 *   - color: paleta UI (alineada con feedback_vamo_company_colors.md)
 *   - license: atribución legal
 *   - contact: web oficial / soporte
 *
 * Para sumar operator nuevo:
 *   1. Agregar entry acá
 *   2. Asegurar que cada feed.adapterId está en `lib/adapters/registry.js`
 *   3. Asociar a 1+ jurisdicciones/metroAreas/nationalNetworks vía `coverage`
 */

const OPERATORS = [
  // ===========================================================================
  // URUGUAY
  // ===========================================================================
  {
    id: "imm",
    displayName: "IMM — Intendencia de Montevideo",
    country: "UY",
    kind: "public-agency",
    color: { palette: "stm", reservedFor: "official" },
    license: "Datos abiertos Intendencia de Montevideo (CC BY 4.0)",
    contact: "https://montevideo.gub.uy/",
    feeds: [
      // Bus urbano: STM (Sistema de Transporte Metropolitano) — feed live OAuth.
      { mode: "bus", service: "urban", dataMode: "official", adapterId: "imm-stm" },
    ],
    coverage: {
      jurisdictions: ["uy.mvd"],
      metroAreas: ["uy.mvd-area-metro"],
    },
  },
];

const OPERATORS_BY_ID = Object.fromEntries(OPERATORS.map((o) => [o.id, o]));

/**
 * Devuelve los operators que cubren una jurisdicción dada.
 * Buscar por: jurisdictions[] directa, metroAreas[] (si la juris es parte
 * de un metroArea cubierto), o nationalNetworks[] (si la juris está en la red).
 *
 * @param {string} jurisdictionId
 * @param {object} opts - { metroAreas: [...], nationalNetworks: [...] } para
 *   resolver coverage indirecto. Si no se pasan, solo busca matches directos.
 */
function getOperatorsForJurisdiction(jurisdictionId, opts = {}) {
  const { metroAreas = [], nationalNetworks = [] } = opts;
  return OPERATORS.filter((o) => {
    if (o.coverage.jurisdictions?.includes(jurisdictionId)) return true;
    if (metroAreas.some((ma) => o.coverage.metroAreas?.includes(ma))) return true;
    if (nationalNetworks.some((nn) => o.coverage.nationalNetworks?.includes(nn))) return true;
    return false;
  });
}

/**
 * Devuelve los feeds disponibles para (jurisdiction, mode, service?) cruzando
 * todos los operators que la cubren.
 */
function getFeedsForJurisdictionMode(jurisdictionId, mode, service, opts = {}) {
  const ops = getOperatorsForJurisdiction(jurisdictionId, opts);
  const out = [];
  for (const op of ops) {
    for (const feed of op.feeds) {
      if (feed.mode !== mode) continue;
      if (service && feed.service !== service) continue;
      out.push({ operatorId: op.id, ...feed });
    }
  }
  return out;
}

module.exports = {
  OPERATORS,
  OPERATORS_BY_ID,
  getOperatorsForJurisdiction,
  getFeedsForJurisdictionMode,
};
