"use client";

import { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Bus, BusStop } from "@/lib/types";
import { COMPANY_COLORS } from "@/lib/types";
import type { CommunityBus } from "@/hooks/useCommunityBuses";

// Centro de Montevideo
const MVD_CENTER: [number, number] = [-34.9011, -56.1645];
const MVD_ZOOM = 12;

function makeBusIcon(line: string, color: string) {
  return L.divIcon({
    className: "bus-marker",
    html: `<div style="
      background: ${color};
      color: white;
      padding: 3px 7px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      font-family: system-ui, sans-serif;
      border: 2px solid white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      white-space: nowrap;
      ">${line}</div>`,
    iconSize: [30, 18],
    iconAnchor: [15, 9],
  });
}

interface LiveMapProps {
  buses: Bus[];
  stops?: BusStop[];
  communityBuses?: CommunityBus[];
  showStops?: boolean;
  lineFilter?: string;
  companyFilter?: string;
}

export default function LiveMap({
  buses,
  stops = [],
  communityBuses = [],
  showStops = false,
  lineFilter,
  companyFilter,
}: LiveMapProps) {
  const filteredBuses = useMemo(() => {
    return buses.filter((b) => {
      if (lineFilter && b.line !== lineFilter) return false;
      if (companyFilter && b.company !== companyFilter) return false;
      return true;
    });
  }, [buses, lineFilter, companyFilter]);

  return (
    <MapContainer
      center={MVD_CENTER}
      zoom={MVD_ZOOM}
      className="h-full w-full rounded-2xl"
      scrollWheelZoom={true}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      />

      {/* Paradas (si están habilitadas) */}
      {showStops &&
        stops.slice(0, 500).map((stop) => (
          <CircleMarker
            key={`stop-${stop.id}`}
            center={[stop.location.coordinates[1], stop.location.coordinates[0]]}
            radius={3}
            pathOptions={{
              color: "#94a3b8",
              fillColor: "#94a3b8",
              fillOpacity: 0.7,
              weight: 1,
            }}
          >
            <Popup>
              <div style={{ fontSize: 12 }}>
                <strong>#{stop.id}</strong>
                <br />
                {stop.street1 && stop.street2
                  ? `${stop.street1} y ${stop.street2}`
                  : stop.street1 || stop.street2 || "—"}
                <br />
                <a
                  href={`/stops/detail?id=${stop.id}`}
                  style={{ color: "#6366f1", fontWeight: 600 }}
                >
                  Editar →
                </a>
              </div>
            </Popup>
          </CircleMarker>
        ))}

      {/* Community buses (violeta) */}
      {communityBuses.map((cb) => (
        <CircleMarker
          key={`cb-${cb.id}`}
          center={[cb.lat, cb.lng]}
          radius={8}
          pathOptions={{
            color: "#a855f7",
            fillColor: "#a855f7",
            fillOpacity: 0.3,
            weight: 2,
          }}
        >
          <Popup>
            <div style={{ fontSize: 12 }}>
              <strong>Línea {cb.line}</strong> · {cb.company}
              <br />
              <span style={{ color: "#a855f7", fontWeight: 600 }}>
                Reporte comunitario
              </span>
              <br />
              {cb.destination && <>→ {cb.destination}<br /></>}
              {(cb.speed * 3.6).toFixed(0)} km/h
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Buses oficiales */}
      {filteredBuses.map((bus) => {
        const coords = bus.location?.coordinates;
        if (!coords) return null;
        const color = COMPANY_COLORS[bus.company] || "#64748b";
        return (
          <Marker
            key={bus.id}
            position={[coords[1], coords[0]]}
            icon={makeBusIcon(bus.line, color)}
          >
            <Popup>
              <div style={{ fontSize: 12 }}>
                <strong>Línea {bus.line}</strong> · {bus.company}
                <br />
                ID: <code>{bus.id}</code>
                <br />
                {bus.destination && <>→ {bus.destination}<br /></>}
                {bus.speed !== null && bus.speed !== undefined && (
                  <>{(bus.speed * 3.6).toFixed(0)} km/h<br /></>
                )}
                {bus.emissions === "Cero emisiones" && "⚡ Eléctrico "}
                {bus.thermalConfort === "Aire Acondicionado" && "❄️ AC "}
                {bus.access === "PISO BAJO" && "♿ Accesible"}
                <br />
                <a
                  href={`/lines/detail?line=${encodeURIComponent(bus.line)}`}
                  style={{ color: "#6366f1", fontWeight: 600 }}
                >
                  Ver línea →
                </a>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
