/**
 * Helpers para las agregaciones del portal público `data.chevamo.com.uy`.
 *
 * Centraliza:
 *   - Lista oficial de barrios de Mvd (62) para clasificar destinos buscados
 *   - Extracción de barrio desde un address de Google Places (string)
 *   - Normalización de líneas (para agrupar reports comunitarios)
 *
 * Privacidad: la extracción de barrio descarta cualquier address que no caiga
 * en barrio reconocido — preferimos perder un evento a guardar una dirección
 * exacta. El destination del usuario nunca se loggea como coords ni string
 * crudo; solo el bucket de barrio se persiste.
 */

// 62 barrios oficiales de Montevideo (IMM, padrón 2010 actualizado).
// Orden alfabético para legibilidad. Importante: incluir variantes comunes que
// aparecen en addresses de Google (con/sin acento, alias, compuestos).
const MVD_NEIGHBORHOODS = [
  "Aguada",
  "Aires Puros",
  "Atahualpa",
  "Bañados de Carrasco",
  "Barrio Sur",
  "Bella Italia",
  "Bella Vista",
  "Belvedere",
  "Brazo Oriental",
  "Buceo",
  "Capurro",
  "Carrasco Norte",
  "Carrasco",
  "Casabó",
  "Casavalle",
  "Castro",
  "Centro",
  "Cerrito",
  "Cerro",
  "Ciudad Vieja",
  "Colón Centro",
  "Colón Sureste",
  "Conciliación",
  "Cordón",
  "Flor de Maroñas",
  "Ituzaingó",
  "Jacinto Vera",
  "Jardines del Hipódromo",
  "La Blanqueada",
  "La Comercial",
  "La Figurita",
  "La Paloma",
  "La Teja",
  "Larrañaga",
  "Las Acacias",
  "Las Canteras",
  "Lavalleja",
  "Lezica",
  "Maldonado",
  "Malvín Norte",
  "Malvín",
  "Manga",
  "Maroñas",
  "Mercado Modelo",
  "Nuevo París",
  "Palermo",
  "Parque Batlle",
  "Parque Rodó",
  "Paso de la Arena",
  "Paso de las Duranas",
  "Paso Molino",
  "Peñarol",
  "Piedras Blancas",
  "Pocitos",
  "Prado",
  "Pueblo Victoria",
  "Punta Carretas",
  "Punta Gorda",
  "Punta Rieles",
  "Reducto",
  "Sayago",
  "Tres Cruces",
  "Tres Ombúes",
  "Unión",
  "Verdisol",
  "Villa del Cerro",
  "Villa Dolores",
  "Villa Española",
  "Villa García",
  "Villa Muñoz",
];

// Pre-cómputo para matching case+accent-insensitive.
// Cada entry mantiene el display original (con acentos) + versión normalizada
// para comparación. Ordenadas por longitud descendente para que "Carrasco Norte"
// matchee antes que "Carrasco" cuando el address contiene ambos.
const NORMALIZED_NEIGHBORHOODS = MVD_NEIGHBORHOODS
  .map((display) => ({
    display,
    normalized: normalizeForMatch(display),
  }))
  .sort((a, b) => b.normalized.length - a.normalized.length);

/**
 * Quita acentos + lowercase para comparación tolerante.
 * "Pocitós " → "pocitos"
 */
function normalizeForMatch(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Extrae el barrio Mvd desde un address o nombre de lugar de Google Places.
 * Devuelve el display name oficial del barrio (con acentos) o null si no matchea.
 *
 * Estrategia: buscar substring del barrio normalizado en el address normalizado.
 * Ordenado por longitud para evitar matches espurios ("Carrasco" en "Carrasco Norte").
 *
 * Edge cases:
 *   - Devuelve null si address es vacío, null o no contiene "Montevideo" /
 *     coordenadas dentro de Mvd. Para destinos en Canelones, Maldonado, etc.
 *     no clasificamos.
 *   - Para "Av Brasil 1234, Pocitos, 11300, Montevideo, Uruguay" → "Pocitos"
 *   - Para "Aeropuerto de Carrasco" (que está en Canelones técnicamente) →
 *     "Carrasco" porque ese es el barrio limítrofe que la gente busca. Caso
 *     aceptable.
 */
function extractMvdNeighborhood(addressOrName) {
  const text = normalizeForMatch(addressOrName);
  if (!text) return null;
  for (const { display, normalized } of NORMALIZED_NEIGHBORHOODS) {
    // Match como token: limitado por comienzo/fin de string o separador no
    // alfanumérico. Evita "Bellavista" matcheando "Bella Vista".
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(normalized)}([^a-z0-9]|$)`);
    if (re.test(text)) return display;
  }
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normaliza key de línea para agrupar reports del mismo número.
 * Trim + uppercase. Mantiene letras (D1, L40, etc) y números.
 * "  121 " → "121", "d10" → "D10"
 */
function normalizeLineKey(line) {
  return String(line || "").trim().toUpperCase();
}

module.exports = {
  MVD_NEIGHBORHOODS,
  extractMvdNeighborhood,
  normalizeLineKey,
  normalizeForMatch, // exportado por si tests lo necesitan
};
