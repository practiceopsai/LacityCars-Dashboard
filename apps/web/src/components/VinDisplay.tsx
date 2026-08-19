"use client";

import { useState } from "react";

/**
 * Compact masked VIN with the full VIN always available to assistive tech
 * (sr-only) and on demand via toggle + copy.
 */
export function VinDisplay({ vin, masked }: { vin: string; masked: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(vin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; expanded view still shows the VIN */
    }
  }

  return (
    <span className="vin">
      <button
        type="button"
        className="btn btn-sm"
        style={{ fontFamily: "inherit", padding: "1px 6px", fontSize: 12 }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        aria-label={expanded ? "Collapse VIN" : `Show full VIN ${vin}`}
        title={vin}
      >
        {expanded ? vin : masked}
      </button>
      <span className="sr-only">Full VIN: {vin}</span>{" "}
      <button
        type="button"
        className="btn btn-sm"
        style={{ padding: "1px 6px", fontSize: 11 }}
        onClick={copy}
        aria-label={`Copy VIN ${vin}`}
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}
