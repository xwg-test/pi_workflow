#!/usr/bin/env node
/**
 * Cross-platform Workflow launcher (macOS / Linux / Windows).
 * Usage: npm start            → http://127.0.0.1:3180
 *        npm run dev          → auto-restart on source change (--watch)
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORCH = path.join(ROOT, "packages", "orchestrator");
const ENTRY = path.join(ORCH, "src", "index.js");
const watch = process.argv.includes("--watch");

// 1) ensure orchestrator deps installed
if (!existsSync(path.join(ORCH, "node_modules"))) {
  console.log("Installing orchestrator dependencies…");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: ORCH, stdio: "inherit", shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 2) resolve node args (watch mode adds --watch)
const nodeArgs = watch ? ["--watch", ENTRY] : [ENTRY];

// 3) launch orchestrator (inherit stdio so Ctrl+C / logs pass through)
console.log("Starting Workflow → http://127.0.0.1:3180  (Ctrl+C to stop)");
const child = spawn(process.execPath, nodeArgs, {
  cwd: ORCH,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
