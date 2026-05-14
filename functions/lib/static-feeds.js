/**
 * Catálogo de feeds GTFS estáticos (paradas / rutas / shapes / calendario).
 *
 * GTFS estático ≠ GTFS-Realtime. Estos feeds son fotos del sistema (paradas,
 * recorridos, frecuencias) que se publican con baja frecuencia (semanal-mensual).
 * Vamo los necesita para:
 *   - Mostrar paradas en el mapa cuando NO hay feed RT
 *   - Lookups de `route_short_name` / `headsign` desde un trip_id en RT
 *   - Shapes (polyline) para dibujar líneas
 *   - Calendario de servicio (qué días corre cada trip)
 *
 * Cada entry define:
 *   - feedId: identificador único, ej `imm-stm-static`
 *   - cityIds: array de cityIds de `lib/cities.js` que cubre este feed
 *   - sourceUrl: URL pública del ZIP GTFS (descarga directa)
 *   - bbox: { swLat, swLng, neLat, neLng } — filtro geográfico, descarta paradas fuera
 *   - refreshIntervalDays: cada cuántos días re-descargar
 *   - license: SPDX o texto libre (para atribución)
 *   - notes: comentarios de auditoría
 *
 * NO confundir con `lib/cities.js` (ese mantiene RT feeds + dataMode por modo).
 * Este registry es complementario: mismo cityId puede tener feed RT (real-time) +
 * feed static (catálogo).
 *
 * Sumar feed:
 *   1. Conseguir URL pública de ZIP GTFS (verificar con HEAD que existe)
 *   2. Determinar bbox (usualmente coincide con bbox de la(s) ciudad(es) cubiertas)
 *   3. Agregar entry acá
 *   4. Correr pipeline con `runStaticGtfsPipeline?feedId=<id>` para validar
 */

const STATIC_FEEDS = [
  {
    feedId:              "imm-stm-static",
    cityIds:             ["uy.mvd-area-metro"],
    // GTFS oficial IMM Mvd urbano (STM-MVD). URL pública oficial pendiente con
    // IMM (`pci@imm.gub.uy`). Mientras tanto re-hosting en GCS público del
    // proyecto vamo-dbad6 — el ZIP se actualiza al recibir nuevo feed de IMM.
    sourceUrl:           "https://storage.googleapis.com/vamo-dbad6.firebasestorage.app/gtfs-source/imm-stm.zip",
    bbox:                { swLat: -34.95, swLng: -56.50, neLat: -34.40, neLng: -55.80 },
    refreshIntervalDays: 30,
    license:             "IMM Montevideo — uso público (pci@imm.gub.uy)",
    notes:               "GTFS oficial Sistema de Transporte Metropolitano IMM. Versión 20260330, vigente 2026-03-30 a 2026-04-30. ~3.5k paradas + ~600 shapes + stop_times.txt 85MB. Re-hosting en GCS hasta tener URL pública oficial IMM.",
  },
];

const STATIC_FEEDS_BY_ID = Object.fromEntries(STATIC_FEEDS.map((f) => [f.feedId, f]));

function getStaticFeed(feedId) {
  return STATIC_FEEDS_BY_ID[feedId] || null;
}

module.exports = { STATIC_FEEDS, STATIC_FEEDS_BY_ID, getStaticFeed };
