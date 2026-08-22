import { SEED_STORES, validateStoreCharges } from "@lacity/shared";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "./index";

/**
 * Deterministic seed: upserts the initial store registry keyed by store code.
 * Safe to run repeatedly; never touches vehicles or events.
 * Deliberately stores no accounting PINs or operational credentials.
 */
async function main(): Promise<void> {
  const prisma = getPrisma();

  for (const store of SEED_STORES) {
    const check = validateStoreCharges(store.internalCharges, store.chargesTotal);
    if (!check.ok) {
      throw new Error(`Seed store ${store.code} has inconsistent charges: ${check.error}`);
    }
    const internalCharges = store.internalCharges as unknown as Prisma.InputJsonValue;
    await prisma.store.upsert({
      where: { code: store.code },
      create: {
        code: store.code,
        name: store.name,
        aliases: store.aliases,
        stockPrefix: store.stockPrefix,
        autosoftInstance: store.autosoftInstance,
        rdpWindowTitle: store.rdpWindowTitle,
        internalCharges,
        chargesTotal: store.chargesTotal,
        active: true,
      },
      update: {
        name: store.name,
        aliases: store.aliases,
        stockPrefix: store.stockPrefix,
        autosoftInstance: store.autosoftInstance,
        rdpWindowTitle: store.rdpWindowTitle,
        internalCharges,
        chargesTotal: store.chargesTotal,
        active: true,
      },
    });
    console.log(`Seeded store ${store.code} (${store.name})`);
  }
}

main()
  .then(async () => {
    await getPrisma().$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await getPrisma().$disconnect();
    process.exit(1);
  });
