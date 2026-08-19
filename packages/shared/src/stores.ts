export interface InternalCharge {
  label: string;
  /** Whole dollars. */
  amount: number;
}

export interface StoreConfig {
  code: string;
  name: string;
  aliases: string[];
  stockPrefix: string;
  autosoftInstance: string;
  internalCharges: InternalCharge[];
  chargesTotal: number;
}

export interface ChargeValidationResult {
  ok: boolean;
  computedTotal: number;
  error?: string;
}

/** Internal charges must sum exactly to the declared total — mismatches are rejected. */
export function validateStoreCharges(
  charges: InternalCharge[],
  declaredTotal: number,
): ChargeValidationResult {
  if (charges.length === 0) {
    return { ok: false, computedTotal: 0, error: "At least one internal charge is required" };
  }
  for (const charge of charges) {
    if (!charge.label.trim()) {
      return { ok: false, computedTotal: 0, error: "Every charge needs a label" };
    }
    if (!Number.isFinite(charge.amount) || charge.amount < 0) {
      return {
        ok: false,
        computedTotal: 0,
        error: `Charge "${charge.label}" must be a non-negative number`,
      };
    }
  }
  const computedTotal = charges.reduce((sum, c) => sum + c.amount, 0);
  if (computedTotal !== declaredTotal) {
    return {
      ok: false,
      computedTotal,
      error: `Charges sum to ${computedTotal} but declared total is ${declaredTotal}`,
    };
  }
  return { ok: true, computedTotal };
}

/**
 * Initial store registry. The database seed is derived from this;
 * additional stores are added through the Store Settings UI / API.
 * Deliberately contains no accounting PINs or operational credentials.
 */
export const SEED_STORES: StoreConfig[] = [
  {
    code: "LA_CITY",
    name: "LA City",
    aliases: ["LA", "LA City Cars"],
    stockPrefix: "L",
    autosoftInstance: "LA City Cars",
    internalCharges: [
      { label: "Pack", amount: 1761 },
      { label: "LoJack", amount: 134 },
      { label: "CSC3MPro", amount: 55 },
      { label: "Cilajet", amount: 54 },
    ],
    chargesTotal: 2004,
  },
  {
    code: "COLUMBIA_CITY",
    name: "Columbia City",
    aliases: ["Columbia", "Columbia City Cars"],
    stockPrefix: "S",
    autosoftInstance: "Columbia City Cars LLC",
    internalCharges: [
      { label: "Pack", amount: 1761 },
      { label: "LoJack", amount: 134 },
      { label: "CSC3MPro", amount: 55 },
      { label: "Cilajet", amount: 54 },
    ],
    chargesTotal: 2004,
  },
];

/** Case-insensitive store resolution by code, name, or alias. */
export function matchesStore(store: StoreConfig, input: string): boolean {
  const needle = input.trim().toLowerCase();
  if (!needle) return false;
  if (store.code.toLowerCase() === needle) return true;
  if (store.name.toLowerCase() === needle) return true;
  return store.aliases.some((a) => a.toLowerCase() === needle);
}
