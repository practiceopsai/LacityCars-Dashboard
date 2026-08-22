import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

// BullMQ concurrency=1 protects one worker process, but Railway briefly runs
// old and new deployments together. This Redis lease makes the check-and-claim
// phase exclusive across every worker replica and every dispatch type.
export const DESKTOP_DISPATCH_LOCK_KEY = "lacity:hermes-desktop-dispatch-claim";
export const DESKTOP_DISPATCH_LOCK_TTL_MS = 5 * 60 * 1000;

const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface DesktopDispatchLock {
  release: () => Promise<void>;
}

export async function acquireDesktopDispatchLock(
  redis: Redis,
  owner: string,
): Promise<DesktopDispatchLock | null> {
  const token = `${owner}:${randomUUID()}`;
  const acquired = await redis.set(
    DESKTOP_DISPATCH_LOCK_KEY,
    token,
    "PX",
    DESKTOP_DISPATCH_LOCK_TTL_MS,
    "NX",
  );
  if (acquired !== "OK") return null;

  return {
    release: async () => {
      await redis.eval(RELEASE_IF_OWNER, 1, DESKTOP_DISPATCH_LOCK_KEY, token);
    },
  };
}
