"use client";

import { useEffect, useState } from "react";
import { getBuses } from "@/lib/api";
import type { Bus } from "@/lib/types";

export function useBuses(pollMs = 30000) {
  const [buses, setBuses] = useState<Bus[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchBuses() {
      try {
        const data = await getBuses();
        if (cancelled) return;
        setBuses(data);
        setLastUpdate(new Date());
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Error fetching buses");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchBuses();
    const interval = setInterval(fetchBuses, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs]);

  return { buses, loading, lastUpdate, error };
}
