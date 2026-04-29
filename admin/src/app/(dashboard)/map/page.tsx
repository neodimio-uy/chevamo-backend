"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useBuses } from "@/hooks/useBuses";
import { useCommunityBuses } from "@/hooks/useCommunityBuses";
import { getBusStops } from "@/lib/api";
import type { BusStop } from "@/lib/types";
import { COMPANIES, COMPANY_COLORS } from "@/lib/types";

// Leaflet no soporta SSR; lo cargamos solo en cliente.
const LiveMap = dynamic(() => import("@/components/LiveMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center rounded-2xl bg-bg-card">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  ),
});

export default function MapPage() {
  const { buses, lastUpdate, error } = useBuses(15000);
  const { buses: communityBuses } = useCommunityBuses();
  const [stops, setStops] = useState<BusStop[]>([]);
  const [showStops, setShowStops] = useState(false);
  const [companyFilter, setCompanyFilter] = useState<string>("");
  const [lineSearch, setLineSearch] = useState("");

  useEffect(() => {
    getBusStops().then(setStops).catch(() => {});
  }, []);

  const availableLines = useMemo(() => {
    const set = new Set<string>();
    for (const b of buses) set.add(b.line);
    return Array.from(set).sort();
  }, [buses]);

  const filteredLine = lineSearch.trim() || undefined;

  const displayedCount = useMemo(() => {
    return buses.filter((b) => {
      if (filteredLine && b.line !== filteredLine) return false;
      if (companyFilter && b.company !== companyFilter) return false;
      return true;
    }).length;
  }, [buses, filteredLine, companyFilter]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Header + controles */}
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-text">Mapa en vivo</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {error
              ? "Error al cargar buses"
              : `${displayedCount} de ${buses.length} buses${lastUpdate ? ` · actualizado ${timeAgo(lastUpdate)}` : ""}`}
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          className="rounded-xl border border-border bg-bg-input px-4 py-2 text-sm text-text focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        >
          <option value="">Todas las empresas</option>
          {COMPANIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <input
          type="text"
          list="lines-list"
          value={lineSearch}
          onChange={(e) => setLineSearch(e.target.value)}
          placeholder="Filtrar por línea (ej: 124)"
          className="w-48 rounded-xl border border-border bg-bg-input px-4 py-2 text-sm text-text placeholder:text-text-muted focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        />
        <datalist id="lines-list">
          {availableLines.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>

        <button
          onClick={() => setShowStops(!showStops)}
          className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
            showStops
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-text-secondary hover:border-border-focus"
          }`}
        >
          {showStops ? "Ocultar paradas" : `Mostrar paradas (${stops.length})`}
        </button>

        <div className="ml-auto flex items-center gap-4 text-xs">
          {COMPANIES.map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <span
                className="h-3 w-3 rounded"
                style={{ backgroundColor: COMPANY_COLORS[c] }}
              />
              <span className="text-text-muted">{c}</span>
            </div>
          ))}
          {communityBuses.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-[#a855f7] bg-[#a855f7]/30" />
              <span className="text-text-muted">
                Comunidad ({communityBuses.length})
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Mapa */}
      <div className="flex-1 overflow-hidden rounded-2xl border border-border shadow-sm">
        <LiveMap
          buses={buses}
          stops={stops}
          communityBuses={communityBuses}
          showStops={showStops}
          lineFilter={filteredLine}
          companyFilter={companyFilter || undefined}
        />
      </div>
    </div>
  );
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 5) return "ahora";
  if (secs < 60) return `hace ${secs}s`;
  return `hace ${Math.floor(secs / 60)}m`;
}
