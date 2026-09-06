/**
 * worktable-orchestrator — strict-JSONL client over a spawned `pi --mode rpc` process.
 *
 * Protocol rules from pi docs/rpc.md (hard requirements):
 *  - Records are split on LF ("\n") ONLY. Do NOT use Node readline (it also splits
 *    on U+2028/U+2029 inside JSON strings).
 *  - A trailing "\r" on a line is stripped (accepts \r\n input).
 *  - Commands go to stdin as one JSON object + "\n".
 *  - Responses come back as { type: "response", ... }; events stream as their own types.
 *
 * Drive model: one long-lived pi child = one isolated agent session. The orchestrator
 * spawns exactly one of these per pane. Isolation is process-level by construction.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const rpcEntryCandidates = (modulesRoot) => [
  path.join(modulesRoot, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  path.join(modulesRoot, "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  path.join(modulesRoot, "@agegr", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
];

/**
 * Resolve the actual command/argv needed to run `pi` WITHOUT going through the
 * `.cmd` shim (Node cannot spawn .cmd with shell:false). Mirrors what pi.cmd does
 * by locating pi on PATH, treating that dir/node_modules as the global module root,
 * then launching node <dist/bundle/cli.js>. Falls back to bare `pi` as a last resort.
 * @returns {{command:string, argv0?:string}}
 */
function resolvePi(bin) {
  if (bin && bin !== "pi") return { command: bin };

  const which = (name) => {
    // minimal $PATHEXT-aware lookup on each PATH entry (works for win & posix enough)
    const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const cand = path.join(dir, name + ext);
        try { if (existsSync(cand)) return cand; } catch { /* ignore */ }
      }
    }
    return null;
  };

  const piPath = which("pi");
  if (piPath) {
    const shimDir = path.dirname(piPath);
    const modulesRoot = path.join(shimDir, "node_modules");
    for (const c of rpcEntryCandidates(modulesRoot)) {
      if (existsSync(c)) return { command: process.execPath, argv0: c };
    }
    // `.cmd` as last fallback for non-global pi installs
  }
  // final fallback: bare command name (OS-level shim resolution, may be a shell shim)
  return { command: "pi" };
}

let nextCorrId = 1;

export class PiRpcClient {
  /**
   * @param {object} opts
   * @param {string} [opts.bin]  pi binary name or path (default "pi")
   * @param {string} [opts.sessionDir]   --session-dir (per-pane isolated storage)
   * @param {string} [opts.model]        --model 'provider/id' or bare id
   * @param {string} [opts.cwd]          working dir for the child process (project root)
   * @param {object} [opts.events] callbacks keyed by event types + a wildcard
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.pending = new Map(); // corrId -> resolve
    this.listeners = opts.listeners ?? null;
    this.closed = false;
    this._buffer = "";
  }

  get isRunning() {
    return !!this.child && !this.child.killed && !this.closed;
  }
  async start() {
    const args = ["--mode", "rpc"];
    if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile);
    if (this.opts.sessionDir) args.push("--session-dir", this.opts.sessionDir);
    // default name so sessions are identifiable in listings
    if (this.opts.name) args.push("--name", this.opts.name);
    // NOTE: intentionally NOT passing --model here in M0 (uses pi default from ~/.pi).
    // model selection is a M3 feature (per-pane set_model).

    const { command, argv0 } = resolvePi(this.opts.bin ?? "pi");
    const execNode = command === process.execPath || command === "node";
    const spawnArgs = execNode && argv0 ? [argv0, ...args] : args;
    const child = spawn(command, spawnArgs, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;

    // --- stdout: strict JSONL reader (LF-only framing, strip trailing \r) ---
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));

    // --- stderr: pi diagnostics pass through to the orchestrator console ---
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[pi ${this.opts.name ?? ""}] ${chunk}`);
    });

    // --- lifecycle ---
    child.on("error", (err) => {
      this.closed = true;
      this._emit("_error", { error: err.message });
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      this._rejectAllPending(new Error(`pi exited (code=${code} signal=${signal})`));
      this._emit("_exit", { code, signal });
    });

    // Give pi a tick to boot. Real readiness is confirmed by the first successful
    // command round-trip (e.g. get_state), which M0 awaits before wiring the pane.
    return this;
  }

  _onData(chunk) {
    this._buffer += chunk;
    while (true) {
      const nl = this._buffer.indexOf("\n");
      if (nl === -1) break;
      let line = this._buffer.slice(0, nl);
      this._buffer = this._buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue; // skip empty keepalive/blank lines defensively
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // pi shouldn't emit malformed frames; surface but don't crash the stream.
        this._emit("_parse_error", { raw: line });
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.type === "response") {
      // resolve the correlated waiter
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (waiter) {
        this.pending.delete(msg.id);
        waiter.resolve(msg);
      } else {
        this._emit("_unmatched_response", msg);
      }
      return;
    }
    // Everything else is an event (message_update, agent_end, extension_ui_request...)
    this._emit(msg.type, msg);
  }

  _emit(type, payload) {
    if (this.opts.onEvent) {
      try {
        this.opts.onEvent(type, payload);
      } catch (err) {
        process.stderr.write(`[pi client] onEvent handler threw: ${err.stack}\n`);
      }
    }
  }

  _rejectAllPending(err) {
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /**
   * Send a command and resolve with the correlated response.
   * @param {object} cmd command body (e.g. { type: "get_state" })
   */
  send(cmd) {
    if (!this.isRunning) return Promise.reject(new Error("pi rpc child not running"));
    return new Promise((resolve, reject) => {
      const id = String(nextCorrId++);
      const full = { ...cmd, id };
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify(full) + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Convenience typed shorthands for the most common M0 calls. */
  get_state() {
    return this.send({ type: "get_state" });
  }
  get_messages() {
    return this.send({ type: "get_messages" });
  }
  prompt(message, opts = {}) {
    return this.send({ type: "prompt", message, ...opts });
  }
  abort() {
    return this.send({ type: "abort" });
  }
  new_session() {
    return this.send({ type: "new_session" });
  }
  set_session_name(name) {
    return this.send({ type: "set_session_name", name });
  }

  /** Stop the child (flush pending). */
  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
    this.closed = true;
  }
}
