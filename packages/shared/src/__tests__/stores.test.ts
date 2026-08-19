import { describe, expect, it } from "vitest";
import { matchesStore, SEED_STORES, validateStoreCharges } from "../stores";
import { StoreUpsertSchema } from "../contracts";

describe("validateStoreCharges", () => {
  const charges = [
    { label: "Pack", amount: 1761 },
    { label: "LoJack", amount: 134 },
    { label: "CSC3MPro", amount: 55 },
    { label: "Cilajet", amount: 54 },
  ];

  it("accepts the seeded charge schedule totalling 2004", () => {
    const result = validateStoreCharges(charges, 2004);
    expect(result.ok).toBe(true);
    expect(result.computedTotal).toBe(2004);
  });

  it("rejects a mismatched declared total", () => {
    const result = validateStoreCharges(charges, 2000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2004/);
  });

  it("rejects empty charge lists and negative amounts", () => {
    expect(validateStoreCharges([], 0).ok).toBe(false);
    expect(validateStoreCharges([{ label: "Pack", amount: -1 }], -1).ok).toBe(false);
    expect(validateStoreCharges([{ label: "  ", amount: 5 }], 5).ok).toBe(false);
  });
});

describe("SEED_STORES", () => {
  it("contains LA City and Columbia City with the specified configuration", () => {
    const la = SEED_STORES.find((s) => s.code === "LA_CITY")!;
    const columbia = SEED_STORES.find((s) => s.code === "COLUMBIA_CITY")!;

    expect(la.aliases).toEqual(["LA", "LA City Cars"]);
    expect(la.stockPrefix).toBe("L");
    expect(la.autosoftInstance).toBe("LA City Cars");
    expect(columbia.aliases).toEqual(["Columbia", "Columbia City Cars"]);
    expect(columbia.stockPrefix).toBe("S");
    expect(columbia.autosoftInstance).toBe("Columbia City Cars LLC");

    for (const store of [la, columbia]) {
      expect(validateStoreCharges(store.internalCharges, store.chargesTotal).ok).toBe(true);
      expect(store.chargesTotal).toBe(2004);
    }
  });

  it("resolves stores by code, name, and alias case-insensitively", () => {
    const la = SEED_STORES[0]!;
    expect(matchesStore(la, "la")).toBe(true);
    expect(matchesStore(la, "LA City")).toBe(true);
    expect(matchesStore(la, "la city cars")).toBe(true);
    expect(matchesStore(la, "columbia")).toBe(false);
    expect(matchesStore(la, "")).toBe(false);
  });
});

describe("StoreUpsertSchema", () => {
  const base = {
    code: "TEST_STORE",
    name: "Test Store",
    aliases: ["Test"],
    stockPrefix: "T",
    autosoftInstance: "Test Store LLC",
    internalCharges: [{ label: "Pack", amount: 100 }],
    chargesTotal: 100,
    active: true,
  };

  it("accepts a consistent store", () => {
    expect(StoreUpsertSchema.safeParse(base).success).toBe(true);
  });

  it("rejects when charges do not sum to the declared total", () => {
    const parsed = StoreUpsertSchema.safeParse({ ...base, chargesTotal: 99 });
    expect(parsed.success).toBe(false);
  });

  it("rejects malformed stock prefixes and codes", () => {
    expect(StoreUpsertSchema.safeParse({ ...base, stockPrefix: "toolong" }).success).toBe(false);
    expect(StoreUpsertSchema.safeParse({ ...base, code: "bad code" }).success).toBe(false);
  });
});
