import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Single in-process thread: child-process forking is unreliable on this
    // Windows host (spawn UNKNOWN), matching the cpus:1 Next.js mitigation.
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
