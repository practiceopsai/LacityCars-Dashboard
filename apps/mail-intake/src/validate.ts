import {
  SEED_STORES,
  matchesStore,
  validateVin,
  type IntakeVehicle,
} from "@lacity/shared";
import type { ExtractedRow } from "./extract/types";

export interface RowProblem {
  row: ExtractedRow;
  reasons: string[];
}

export interface ValidationOutcome {
  clean: IntakeVehicle[];
  problems: RowProblem[];
}

/** Resolve a store mention (code, name, or alias) to a canonical store code. */
export function resolveStoreCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const store = SEED_STORES.find((s) => matchesStore(s, input));
  return store ? store.code : null;
}

/**
 * Find a store mention inside free text (subject line or body). Longest-first
 * so "LA City Cars" wins over "LA". Returns null when zero or MULTIPLE distinct
 * stores are mentioned — an ambiguous email must not pick a store by luck.
 */
export function findStoreInText(text: string | null | undefined): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  const found = new Set<string>();
  for (const store of SEED_STORES) {
    const needles = [store.name, ...store.aliases, store.code.replaceAll("_", " ")]
      .map((n) => n.toLowerCase())
      .sort((a, b) => b.length - a.length);
    if (needles.some((needle) => haystack.includes(needle))) {
      found.add(store.code);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * Validate extracted rows into intake-ready vehicles. Rows with any doubt land
 * in `problems` and are never intaken (auto + bounce-unclear policy).
 */
export function validateRows(
  rows: ExtractedRow[],
  fallbackStoreCode: string | null,
  scheduledAt: string,
): ValidationOutcome {
  const clean: IntakeVehicle[] = [];
  const problems: RowProblem[] = [];
  const seenVins = new Set<string>();

  for (const row of rows) {
    const reasons: string[] = [];

    const vinCheck = validateVin(row.vin);
    if (!vinCheck.ok || !vinCheck.vin) {
      reasons.push(...vinCheck.errors);
    }

    // A row that explicitly names a store we don't run must bounce — never
    // silently reassign it to the email's fallback store.
    let storeCode: string | null = null;
    if (row.store) {
      storeCode = resolveStoreCode(row.store);
      if (!storeCode) {
        reasons.push(`Unknown store "${row.store}" — use LA City or Columbia City`);
      }
    } else {
      storeCode = fallbackStoreCode;
      if (!storeCode) {
        reasons.push("No store given in the row, subject, or body");
      }
    }

    const model = row.model?.trim() ?? "";
    if (!model) {
      reasons.push("No model/description for this vehicle");
    }

    if (vinCheck.ok && vinCheck.vin && seenVins.has(vinCheck.vin)) {
      reasons.push("Duplicate VIN within the same email");
    }

    if (reasons.length > 0) {
      problems.push({ row, reasons });
      continue;
    }

    seenVins.add(vinCheck.vin!);
    clean.push({
      store: storeCode!,
      vin: vinCheck.vin!,
      model: model.slice(0, 120),
      ...(row.stockNumber ? { stockNumber: row.stockNumber.slice(0, 32) } : {}),
      ...(row.source ? { source: row.source.slice(0, 80) } : {}),
      scheduledAt,
    });
  }

  return { clean, problems };
}
