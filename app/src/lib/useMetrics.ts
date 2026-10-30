"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, MetricsResponse } from "./types";

const REFRESH_MS = 15_000;

export type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: MetricsResponse; stale: boolean }
  | { kind: "error"; error: ApiError | { error: "network"; message: string } };

/** Polls /api/metrics. A 401 means the session ended, so the caller shows the sign-in screen. */
export function useMetrics(onUnauthorized: () => void) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const lastGood = useRef<MetricsResponse | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/api/metrics", { cache: "no-store", signal: controller.signal });
      if (response.status === 401) {
        lastGood.current = null;
        unauthorized.current();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && body && typeof body === "object" && "components" in body) {
        lastGood.current = body as MetricsResponse;
        setState({ kind: "ready", data: lastGood.current, stale: false });
      } else if (body && typeof body === "object" && "error" in body) {
        throw Object.assign(new Error("api"), { api: body as ApiError });
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const api = (error as { api?: ApiError }).api;
      if (lastGood.current) {
        setState({ kind: "ready", data: lastGood.current, stale: true });
      } else {
        setState({ kind: "error", error: api ?? { error: "network", message: "Could not reach the dashboard API." } });
      }
    } finally {
      if (inFlight.current === controller) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    // Refresh straight away when a backgrounded phone or wall display wakes up.
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [load]);

  return { state, refreshing, reload: load };
}
