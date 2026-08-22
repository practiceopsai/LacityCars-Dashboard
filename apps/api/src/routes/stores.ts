import { Router } from "express";
import type { PrismaClient, Store } from "@lacity/database";
import { StoreUpsertSchema } from "@lacity/shared";
import { HttpError } from "../middleware/error";

function serializeStore(store: Store) {
  return {
    id: store.id,
    code: store.code,
    name: store.name,
    aliases: store.aliases,
    stockPrefix: store.stockPrefix,
    autosoftInstance: store.autosoftInstance,
    rdpWindowTitle: store.rdpWindowTitle,
    internalCharges: store.internalCharges,
    chargesTotal: store.chargesTotal,
    active: store.active,
    updatedAt: store.updatedAt.toISOString(),
  };
}

/**
 * Store registry CRUD. Configuration-driven so new stores need no code change.
 * StoreUpsertSchema rejects charge schedules that do not sum to the declared
 * total. No credentials/PINs are ever stored here.
 */
export function storesRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const stores = await prisma.store.findMany({ orderBy: { name: "asc" } });
      res.json({ items: stores.map(serializeStore) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:code", async (req, res, next) => {
    try {
      const store = await prisma.store.findUnique({ where: { code: req.params.code } });
      if (!store) throw new HttpError(404, "STORE_NOT_FOUND", `No store ${req.params.code}`);
      res.json(serializeStore(store));
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const data = StoreUpsertSchema.parse(req.body);
      const existing = await prisma.store.findUnique({ where: { code: data.code } });
      if (existing) {
        throw new HttpError(409, "STORE_EXISTS", `Store ${data.code} already exists`);
      }
      const store = await prisma.store.create({
        data: {
          code: data.code,
          name: data.name,
          aliases: data.aliases,
          stockPrefix: data.stockPrefix,
          autosoftInstance: data.autosoftInstance,
          rdpWindowTitle: data.rdpWindowTitle,
          internalCharges: data.internalCharges,
          chargesTotal: data.chargesTotal,
          active: data.active,
        },
      });
      res.status(201).json(serializeStore(store));
    } catch (err) {
      next(err);
    }
  });

  router.put("/:code", async (req, res, next) => {
    try {
      const data = StoreUpsertSchema.parse({ ...req.body, code: req.params.code });
      const existing = await prisma.store.findUnique({ where: { code: data.code } });
      if (!existing) throw new HttpError(404, "STORE_NOT_FOUND", `No store ${data.code}`);
      const store = await prisma.store.update({
        where: { code: data.code },
        data: {
          name: data.name,
          aliases: data.aliases,
          stockPrefix: data.stockPrefix,
          autosoftInstance: data.autosoftInstance,
          rdpWindowTitle: data.rdpWindowTitle,
          internalCharges: data.internalCharges,
          chargesTotal: data.chargesTotal,
          active: data.active,
        },
      });
      res.json(serializeStore(store));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
