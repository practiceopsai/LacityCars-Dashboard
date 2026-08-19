import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { Prisma } from "@prisma/client";
export * from "./transitions";

let client: PrismaClient | undefined;

/** Shared singleton so each process holds one connection pool. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
