"use client";

import { useEffect, useRef, useState } from "react";

export type StreamState = "live" | "connecting" | "polling";

const POLL_MS = 20_000;

/**
 * Subscribe to /api/vehicles/stream (SSE). The browser's EventSource handles
 * reconnects; while the stream is not live we fall back to interval polling so
 * the board never goes stale.
 */
export function useVehicleStream(onUpdate: () => void): StreamState {
  const [state, setState] = useState<StreamState>("connecting");
  const stateRef = useRef<StreamState>("connecting");
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const set = (next: StreamState) => {
      stateRef.current = next;
      setState(next);
    };

    const source = new EventSource("/api/vehicles/stream");
    source.onopen = () => set("live");
    source.onerror = () => set("polling");
    source.addEventListener("vehicle-updated", () => onUpdateRef.current());

    const poll = setInterval(() => {
      if (stateRef.current !== "live") {
        onUpdateRef.current();
      }
    }, POLL_MS);

    return () => {
      source.close();
      clearInterval(poll);
    };
  }, []);

  return state;
}
