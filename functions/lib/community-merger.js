/**
 * Merge IMM + Comunidad para `/buses` global (Función 2 de la visión
 * Comunidad). Server-side fusion para que el cliente consuma una sola
 * lista sin tener que mergear nada.
 *
 * **Diferencia con `eta-fusion.buildPureCommunityBuses`:** ese módulo está
 * scoped a una parada (calcula ETA + distancia + stabilizer por par
 * cluster↔stop). Acá no hay parada — solo necesitamos posición para mapa.
 * Sin cálculo ETA. Sin stabilizer.
 *
 * **Tres outputs por bus:**
 *   - `source: "imm"`              — bus IMM sin match comunidad
 *   - `source: "imm+community"`    — bus IMM con cluster comunidad matcheado
 *   - `source: "community"`        — pure community (cluster sin match IMM)
 *
 * **Fusion de coords IMM stale:** si IMM tiene `immAgeSec > IMM_STALE_SEC`
 * y hay cluster matcheado más fresco, se overridea `location.coordinates`
 * con las coords fusionadas (mejor render mapa). Marca con
 * `communityMergeNote: "coords-from-community"`.
 *
 * **Filtro post-merge:** `filterByCurrentUser` excluye pure-community buses
 * cuyos clusters incluyan al user actual (iOS los recibe via listener
 * Firestore propio — evita doble marker).
 */

const positionFuser = require("./position-fuser");
const clusterer = require("./community-clusterer");
const sourceConfidence = require("./source-confidence");

/** Umbral de "IMM stale" para preferir coords comunidad cuando hay match. */
const IMM_STALE_SEC = 30;

/** TTL del cluster pure-community para aparecer en mapa. Mismo umbral que
 *  iOS `CommunityBus.isStale` (90s). Reports más viejos no se renderizan. */
const PURE_COMMUNITY_MAX_AGE_SEC = 90;

/**
 * Mergea una lista de buses IMM con un map de clusters comunidad agrupados
 * por línea. Devuelve `{ mergedBuses, consumedClusterIds, stats }`.
 *
 * No modifica los inputs (returns new objects).
 *
 * @param {object} opts
 * @param {Array}  opts.immBuses         — buses crudos del IMM (schema `/buses`)
 * @param {Map}    opts.clustersByLine   — Map<line, Cluster[]> de community-cache
 * @param {Date}   [opts.now]            — para tests; default new Date()
 * @param {number} [opts.immAgeSec]      — edad estimada del fetch IMM (default 30)
 */
function mergeImmWithCommunity({ immBuses, clustersByLine, now = new Date(), immAgeSec = 30 }) {
  const safeImm = Array.isArray(immBuses) ? immBuses : [];
  const safeClusters = clustersByLine instanceof Map ? clustersByLine : new Map();
  const nowMs = now.getTime();
  const consumedClusterIds = new Set();

  const merged = [];
  let mixedCount = 0;

  for (const bus of safeImm) {
    const match = findMatchingCluster({ bus, clustersByLine: safeClusters, immAgeSec, now });
    if (!match) {
      merged.push({ ...bus, source: "imm" });
      continue;
    }
    const { cluster, fused, comAge } = match;
    const repId = cluster.representative && cluster.representative.id;
    if (repId) consumedClusterIds.add(repId);
    mixedCount += 1;

    const enriched = {
      ...bus,
      source: "imm+community",
      communityConfirmations: cluster.reporterCount,
      communityFreshnessSec: Math.round(comAge),
      communityClusterId: repId || null,
    };

    // Override coords solo si IMM está stale y la fusión generó una posición.
    // Sino respetamos las coords IMM (son la "verdad" oficial).
    // `positionFuser.fuse` retorna `{ coordinate: {lat, lng}, ... }` o null.
    if (immAgeSec > IMM_STALE_SEC && fused && fused.coordinate) {
      enriched.location = {
        type: "Point",
        coordinates: [fused.coordinate.lng, fused.coordinate.lat],
      };
      enriched.communityMergeNote = "coords-from-community";
    }

    merged.push(enriched);
  }

  let pureCommunityCount = 0;
  for (const [line, clusters] of safeClusters.entries()) {
    for (const cluster of clusters) {
      const rep = cluster.representative;
      if (!rep || !rep.id) continue;
      if (consumedClusterIds.has(rep.id)) continue;
      const comAge = clusterer.ageSeconds(rep.updatedAt, nowMs);
      if (comAge > PURE_COMMUNITY_MAX_AGE_SEC) continue;
      if (!Number.isFinite(rep.lat) || !Number.isFinite(rep.lng)) continue;

      merged.push(buildPureCommunityBus({ line, cluster, comAge }));
      pureCommunityCount += 1;
    }
  }

  return {
    mergedBuses: merged,
    consumedClusterIds,
    stats: {
      immCount: safeImm.length,
      mixedCount,
      pureCommunityCount,
      totalCount: merged.length,
    },
  };
}

/**
 * Filtra del response los pure-community buses cuyo cluster incluya al user
 * autenticado. iOS los recibe via listener Firestore propio — evita doble
 * marker. NO filtra buses IMM mixtos (el IMM es info ajena al user, no
 * redundante).
 *
 * Sin `currentUid` o sin clusters, passthrough.
 */
function filterByCurrentUser({ buses, currentUid, clustersByLine }) {
  if (!currentUid || !Array.isArray(buses) || buses.length === 0) {
    return { buses: buses || [], filteredCount: 0 };
  }
  const safeClusters = clustersByLine instanceof Map ? clustersByLine : new Map();
  const excludeClusterIds = new Set();
  for (const clusters of safeClusters.values()) {
    for (const c of clusters) {
      if (c.reporterIds && typeof c.reporterIds.has === "function" && c.reporterIds.has(currentUid)) {
        const id = c.representative && c.representative.id;
        if (id) excludeClusterIds.add(id);
      }
    }
  }
  if (excludeClusterIds.size === 0) return { buses, filteredCount: 0 };

  let filteredCount = 0;
  const out = buses.filter((b) => {
    if (typeof b.busId !== "string" || !b.busId.startsWith("community:")) return true;
    const clusterId = b.busId.slice("community:".length);
    if (excludeClusterIds.has(clusterId)) {
      filteredCount += 1;
      return false;
    }
    return true;
  });
  return { buses: out, filteredCount };
}

/* ─────────────────── internals ─────────────────── */

/**
 * Busca cluster que matchee con un bus IMM. Port liviano de
 * `eta-fusion.matchCluster` sin las dependencias de calibrator/stabilizer
 * (que acá no aplican). Reusa `positionFuser.sameVehicle` con la misma
 * regla estricta línea + variant + radio.
 */
function findMatchingCluster({ bus, clustersByLine, immAgeSec, now }) {
  const line = (bus && bus.line || "").trim();
  if (!line) return null;
  const candidates = clustersByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  const coords = bus.location && bus.location.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [busLng, busLat] = coords;
  if (!Number.isFinite(busLat) || !Number.isFinite(busLng)) return null;

  const nowMs = now.getTime();

  for (const c of candidates) {
    const rep = c.representative;
    if (!rep) continue;

    // Match preferente por officialBusId (cuando el user dijo "voy en este").
    // Evita falsos negativos si las coords IMM y comunidad están desfasadas.
    if (rep.officialBusId && bus.busId && rep.officialBusId === bus.busId) {
      const comAge = clusterer.ageSeconds(rep.updatedAt, nowMs);
      const fused = doFuse({ busLat, busLng, immAgeSec, rep, comAge });
      return { cluster: c, fused, comAge };
    }

    if (!positionFuser.sameVehicle({
      immLine: line,
      immVariantId: bus.lineVariantId,
      immCoord: { lat: busLat, lng: busLng },
      clusterLine: rep.line,
      clusterVariantId: rep.lineVariantId,
      clusterCoord: { lat: rep.lat, lng: rep.lng },
    })) continue;

    const comAge = clusterer.ageSeconds(rep.updatedAt, nowMs);
    const fused = doFuse({ busLat, busLng, immAgeSec, rep, comAge });
    return { cluster: c, fused, comAge };
  }
  return null;
}

function doFuse({ busLat, busLng, immAgeSec, rep, comAge }) {
  const immConf = sourceConfidence.forIMM({
    ageSeconds: immAgeSec,
    isZombie: false,
    speedKmh: null,
  });
  const comConf = sourceConfidence.forCommunity({
    ageSeconds: comAge,
    reporterCount: 1,
    speedKmh: typeof rep.speed === "number" ? rep.speed * 3.6 : null,
  });
  return positionFuser.fuse({
    immCoord: { lat: busLat, lng: busLng },
    immAge: immAgeSec,
    immConfidence: immConf,
    comCoord: { lat: rep.lat, lng: rep.lng },
    comAge,
    comConfidence: comConf,
  });
}

/**
 * Genera un bus pure-community en el shape que consumen los clientes que
 * leen `/buses`. Compatible con `Bus.swift` (iOS reconoce `position: -1`
 * como `DataOrigin.community`).
 *
 * Sin ETA — `/buses` es un endpoint de posición, no de arribos.
 */
function buildPureCommunityBus({ line, cluster, comAge }) {
  const rep = cluster.representative;
  return {
    busId: `community:${rep.id}`,
    line,
    lineVariantId: rep.lineVariantId,
    companyName: rep.company || "",
    company: rep.company || "",
    origin: rep.origin || null,
    destination: rep.destination || null,
    position: -1,
    location: {
      type: "Point",
      coordinates: [rep.lng, rep.lat],
    },
    speed: typeof rep.speed === "number" ? rep.speed : 0,
    source: "community",
    communityConfirmations: cluster.reporterCount,
    communityFreshnessSec: Math.round(comAge),
    communityClusterId: rep.id,
  };
}

module.exports = {
  IMM_STALE_SEC,
  PURE_COMMUNITY_MAX_AGE_SEC,
  mergeImmWithCommunity,
  filterByCurrentUser,
  // exported for tests
  _findMatchingCluster: findMatchingCluster,
  _buildPureCommunityBus: buildPureCommunityBus,
};
