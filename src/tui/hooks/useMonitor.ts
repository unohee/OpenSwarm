// ============================================
// OpenSwarm - useMonitor (EPIC INT-1813 S6 / INT-1939)
// Polls a monitor fetcher on an interval. Network/effect boundary — the mappers
// it renders are pure + tested.
// ============================================

import { useEffect, useState } from 'react';
import type { Table } from '../monitorRows.js';

export interface MonitorResult {
  table: Table | null;
  error: string | null;
  loading: boolean;
}

export function useMonitor(
  port: number | undefined,
  fetcher: (port: number) => Promise<Table>,
  intervalMs = 5000,
): MonitorResult {
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const t = await fetcher(port);
        if (!cancelled) {
          setTable(t);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [port, fetcher, intervalMs]);

  return { table, error, loading };
}
