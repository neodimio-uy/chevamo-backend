import type { BusStop, LineVariant, Bus } from "./types";

const API_BASE = "https://api.chevamo.com.uy";

/**
 * El backend usa el Sanitizer Box: envuelve toda respuesta en
 * `{ ok, data, meta, error }`. Este helper extrae `.data` y maneja el caso
 * de error de forma uniforme.
 */
interface BackendEnvelope<T> {
  ok: boolean;
  data?: T;
  meta?: {
    source?: string;
    stale?: boolean;
    count?: number;
  };
  error?: { code: string; message?: string };
}

async function fetchBackend<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${path}`);
  }
  const body = (await res.json()) as BackendEnvelope<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(
      body.error?.message || body.error?.code || `API returned ok=false: ${path}`
    );
  }
  return body.data;
}

export async function getBuses(): Promise<Bus[]> {
  return fetchBackend("/buses");
}

export async function getBusStops(): Promise<BusStop[]> {
  return fetchBackend("/busstops");
}

export async function getLineVariants(): Promise<LineVariant[]> {
  return fetchBackend("/buses/linevariants");
}

export async function getUpcoming(
  stopId: number,
  amount = 5
): Promise<unknown[]> {
  return fetchBackend(`/busstops/${stopId}/upcoming?amount=${amount}`);
}

export async function getSchedules(
  stopId: number
): Promise<Record<string, string[]>> {
  return fetchBackend(`/busstops/${stopId}/schedules`);
}

export async function getLinesAtStop(stopId: number): Promise<string[]> {
  return fetchBackend(`/busstops/${stopId}/lines`);
}
