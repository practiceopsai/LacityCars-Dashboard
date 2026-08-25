import { spawn, spawnSync } from "node:child_process";

const service = process.env.APP_SERVICE;

const commands = {
  api: ["node", ["apps/api/dist/index.js"]],
  worker: ["node", ["apps/worker/dist/index.js"]],
  web: ["pnpm", ["--filter", "@lacity/web", "start"]],
  "mail-intake": ["node", ["apps/mail-intake/dist/index.js"]],
};

if (!(service in commands)) {
  console.error("APP_SERVICE must be one of: api, worker, web, mail-intake");
  process.exit(1);
}

if (service === "api") {
  for (const args of [
    ["--filter", "@lacity/database", "db:push"],
    ["--filter", "@lacity/database", "db:seed"],
  ]) {
    const result = spawnSync("pnpm", args, { stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const [command, args] = commands[service];
const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
