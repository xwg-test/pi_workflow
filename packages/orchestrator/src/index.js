/**
 * workflow-orchestrator — M4 (project groups + per-project panes).
 *
 * Model:
 *   Project = { id, name, dir }            — a real working directory
 *   Pane    = one isolated `pi --mode rpc` child belonging to ONE project
 *
 * Invariants:
 *   - every project has >= 1 pane (creating a project auto-creates its first pane)
 *   - every project has <= 9 panes
 *   - a pane's cwd = its project's dir; its session file lives under its own --session-dir
 *   - fs:list / fs:read are sandboxed to the pane's project dir
 */
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { existsSync, createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { PiRpcClient } from "./rpc-client.js";
import { ReferenceLibrary } from "./reference-library.js";

const PORT = Number(process.env.PORT || 3180);
const HOST = process.env.HOST || "127.0.0.1";
const __src = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WT_ROOT || path.resolve(__src, "..", "..", ".."); // workflow/
const SESSIONS_ROOT = process.env.WT_SESSIONS_ROOT || path.join(ROOT, ".workflow", "sessions");
const LIB_DIR = process.env.WT_LIB_DIR || path.join(ROOT, ".workflow", "lib");
const UI_DIR = process.env.WT_UI_DIR || path.join(ROOT, "packages", "ui");
const PI_BIN = process.env.PI_BIN || "pi";

const MAX_PANES_PER_PROJECT = 9;
const MAX_PROJECTS = 25; // control-home = 5x5 card wall
const MAX_PREVIEW_BYTES = 512 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

// custom control-home background assets
const ASSETS_DIR = process.env.WT_ASSETS_DIR || path.join(ROOT, ".workflow", "assets");
const HISTORY_FILE = path.join(ASSETS_DIR, "history.json");
const MAX_IMAGE_HISTORY = 10;
const MAX_VIDEO_HISTORY = 5;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;   // 50 MiB
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;  // 300 MiB

// Default seed project = the caller's real working directory (helloPi).
const DEFAULT_PROJECT_DIR = process.env.WT_DEFAULT_PROJECT_DIR || path.resolve(ROOT, "..");

function mimeFor(ext) {
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  })[ext] || "application/octet-stream";
}
async function ensureDir(d) { await mkdir(d, { recursive: true }); }

const seq = { pane: 0, project: 0, session: 0 };
const nextPaneKey = () => `p${++seq.pane}`;
const nextProjectId = () => `proj${++seq.project}`;
const nextSessionId = () => `s${++seq.session}`;

async function main() {
  const lib = new ReferenceLibrary(LIB_DIR);
  await ensureDir(LIB_DIR);

  // projectId -> { id, name, dir, sessions:Set<sessionId>, panes:Set<paneKey> }
  const projects = new Map();
  // sessionId -> { id, projectId, name, sessionDir }
  const sessions = new Map();
  // paneKey -> { pane, projectId, sessionId, client, ready, error }
  const panes = new Map();
  let fan = null;

  function projectDir(pane) {
    const pn = panes.get(pane);
    if (!pn) throw new Error(`unknown pane: ${pane}`);
    const proj = projects.get(pn.projectId);
    return proj ? proj.dir : pn.projectId;
  }
  function resolveInProject(pane, rel) {
    const base = path.resolve(projectDir(pane));
    const target = path.resolve(base, rel || ".");
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error("path escapes project directory");
    }
    return target;
  }

  // ---- session index persistence (per project) ----
  const indexFile = (projectId) => path.join(SESSIONS_ROOT, `${projectId}.json`);
  async function saveSessionIndex(proj) {
    const list = [...proj.sessions].map((sid) => { const s = sessions.get(sid); return { id: s.id, name: s.name, file: s.file || null }; });
    await ensureDir(SESSIONS_ROOT);
    await writeFile(indexFile(proj.id), JSON.stringify(list), "utf8");
  }
  async function loadSessionIndex(proj) {
    try {
      const raw = await readFile(indexFile(proj.id), "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const e of list) {
          if (!e || !e.id) continue;
          const sessionDir = path.join(SESSIONS_ROOT, proj.id, e.id);
          sessions.set(e.id, { id: e.id, projectId: proj.id, name: e.name || e.id, sessionDir, file: e.file || null });
          proj.sessions.add(e.id);
        }
      }
    } catch { /* no index yet */ }
  }

  async function startPane(paneKey, sessionId, projectId) {
    if (sessionId && !sessions.has(sessionId)) throw new Error(`unknown session: ${sessionId}`);
    if (!sessionId) {
      // empty pane (no session bound): placeholder view, no pi process yet
      const proj = projects.get(projectId);
      const pn = { pane: paneKey, projectId: projectId ?? null, sessionId: null, client: null, ready: false, error: null };
      panes.set(paneKey, pn);
      if (proj) proj.panes.add(paneKey);
      return pn;
    }
    const session = sessions.get(sessionId);
    const proj = projects.get(session.projectId);
    if (!proj) throw new Error(`unknown project: ${session.projectId}`);
    await ensureDir(session.sessionDir);
    const client = new PiRpcClient({
      bin: PI_BIN,
      sessionDir: session.sessionDir,
      sessionFile: session.file || null,
      name: sessionId,
      cwd: proj.dir,
      onEvent(type, payload) { fan?.paneEvent(paneKey, type, payload); },
    });
    const pn = { pane: paneKey, projectId: proj.id, sessionId, client, ready: false, error: null };
    panes.set(paneKey, pn);
    proj.panes.add(paneKey);
    try {
      await client.start();
      const st = await probeReadiness(client, 20_000);
      const sf = st?.data?.sessionFile;
      if (sf && !session.file) { session.file = sf; await saveSessionIndex(proj); }
      pn.ready = true;
    } catch (err) {
      pn.error = err.message;
      process.stderr.write(`pane ${paneKey} failed: ${err.message}\n`);
    }
    return pn;
  }

  async function bindPane(paneKey, sessionId) {
    const pn = panes.get(paneKey);
    if (!pn) throw new Error(`unknown pane: ${paneKey}`);
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const proj = projects.get(session.projectId);
    if (!proj) throw new Error(`unknown project: ${session.projectId}`);
    // 1:1 — session can only be bound to one pane
    const already = [...proj.panes].find((pk) => pk !== paneKey && panes.get(pk)?.sessionId === sessionId);
    if (already) throw new Error(`会话 ${sessionId} 已被窗格 ${already} 占用`);
    await ensureDir(session.sessionDir);
    const client = new PiRpcClient({
      bin: PI_BIN,
      sessionDir: session.sessionDir,
      sessionFile: session.file || null,
      name: sessionId,
      cwd: proj.dir,
      onEvent(type, payload) { fan?.paneEvent(paneKey, type, payload); },
    });
    pn.projectId = proj.id;
    pn.sessionId = sessionId;
    pn.client = client;
    proj.panes.add(paneKey);
    try {
      await client.start();
      const st = await probeReadiness(client, 20_000);
      const sf = st?.data?.sessionFile;
      if (sf && !session.file) { session.file = sf; await saveSessionIndex(proj); }
      pn.ready = true;
      pn.error = null;
    } catch (err) {
      pn.error = err.message;
      process.stderr.write(`pane ${paneKey} bind failed: ${err.message}\n`);
    }
    return pn;
  }

  async function probeReadiness(client, ms) {
    const start = Date.now();
    let lastErr;
    while (Date.now() - start < ms) {
      if (!client.isRunning) throw new Error("pi rpc process died during boot");
      try {
        const r = await Promise.race([
          client.get_state(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
        if (r.success) return r;
        lastErr = new Error(r.error || "get_state not ok");
      } catch (e) { lastErr = e; }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw lastErr ?? new Error("timed out waiting for pi");
  }

  async function createProject(name, dir) {
    const id = nextProjectId();
    const abs = path.resolve(dir);
    await ensureDir(abs);
    const proj = { id, name: name || path.basename(abs) || id, dir: abs, sessions: new Set(), panes: new Set() };
    projects.set(id, proj);
    await loadSessionIndex(proj);
    // ensure at least one session
    if (proj.sessions.size === 0) {
      await createSession(id);
    }
    await saveSessionIndex(proj);
    return proj;
  }

  async function createSession(projectId, name) {
    const proj = projects.get(projectId);
    if (!proj) throw new Error(`unknown project: ${projectId}`);
    const sessionId = nextSessionId();
    const sessionDir = path.join(SESSIONS_ROOT, proj.id, sessionId);
    await ensureDir(sessionDir);
    const session = { id: sessionId, projectId, name: name || sessionId, sessionDir, file: null };
    sessions.set(sessionId, session);
    proj.sessions.add(sessionId);
    await saveSessionIndex(proj);
    return session;
  }

  function projectPayload(proj) {
    return {
      id: proj.id, name: proj.name, dir: proj.dir,
      sessions: [...proj.sessions].map((sid) => {
        const s = sessions.get(sid);
        const opened = [...proj.panes].find((pk) => panes.get(pk)?.sessionId === sid);
        return { id: s.id, name: s.name, openPane: opened ?? null };
      }),
      panes: [...proj.panes].map((pk) => {
        const pn = panes.get(pk);
        return { pane: pk, sessionId: pn?.sessionId, running: pn?.ready === true, error: pn?.error || null };
      }),
    };
  }

  // ---- HTTP + WS ----
  const http = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    let p = url.pathname;

    // 0) graceful shutdown endpoint (used by `/workflow stop` plugin)
    if (p === "/shutdown") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(shutdown, 50); // let the response flush before exiting
      return;
    }

    // 1) upload custom background (image <=50MiB, video <=300MiB)
    if (req.method === "POST" && p === "/upload-bg") {
      await handleUploadBg(req, res, url);
      return;
    }

    // 1b) history of uploaded backgrounds
    if (req.method === "GET" && p === "/bg-history") {
      const h = await readHistory();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(h));
      return;
    }

    // 2) serve uploaded background assets
    if (p.startsWith("/assets/")) {
      const name = p.slice("/assets/".length);
      const safeName = path.basename(name); // prevent traversal
      const fpath = path.join(ASSETS_DIR, safeName);
      try {
        const st = await stat(fpath);
        if (!st.isFile()) throw new Error("not a file");
        const ext = path.extname(fpath).toLowerCase();
        const mime = mimeFor(ext) === "application/octet-stream"
          ? (ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : "application/octet-stream")
          : mimeFor(ext);
        res.writeHead(200, { "content-type": mime, "content-length": st.size });
        createReadStream(fpath).pipe(res);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
      return;
    }

    // 3) static UI
    if (p === "/") p = "/index.html";
    const file = path.join(UI_DIR, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const mime = {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".json": "application/json", ".svg": "image/svg+xml",
    }[path.extname(file).toLowerCase()] || "application/octet-stream";
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  async function readHistory() {
    try {
      const raw = await readFile(HISTORY_FILE, "utf8");
      const o = JSON.parse(raw);
      return { images: Array.isArray(o.images) ? o.images : [], videos: Array.isArray(o.videos) ? o.videos : [] };
    } catch { return { images: [], videos: [] }; }
  }
  async function writeHistory(h) {
    await ensureDir(ASSETS_DIR);
    await writeFile(HISTORY_FILE, JSON.stringify(h), "utf8");
  }
  async function pushHistory(type, entry) {
    const h = await readHistory();
    const key = type === "video" ? "videos" : "images";
    const max = type === "video" ? MAX_VIDEO_HISTORY : MAX_IMAGE_HISTORY;
    const list = [entry, ...h[key]].filter((e) => e && e.url);
    // dedupe by url
    const seen = new Set();
    const dedup = [];
    for (const e of list) { if (!seen.has(e.url)) { seen.add(e.url); dedup.push(e); } }
    // trim oldest beyond max, deleting their files
    const kept = dedup.slice(0, max);
    const removed = dedup.slice(max);
    for (const e of removed) {
      const f = path.join(ASSETS_DIR, path.basename(e.url));
      await rm(f, { force: true }).catch(() => {});
    }
    h[key] = kept;
    await writeHistory(h);
    return kept;
  }

  async function handleUploadBg(req, res, url) {
    try {
      const type = url.searchParams.get("type") || "image";
      const rawName = url.searchParams.get("name") || "bg";
      const name = path.basename(rawName); // strip any path
      const maxBytes = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      const len = Number(req.headers["content-length"] || 0);
      if (len <= 0) throw new Error("empty upload");
      if (len > maxBytes) {
        throw new Error(`文件超过限制（${type === "video" ? "300M" : "50M"}）`);
      }
      // whitelist extensions
      const ext = path.extname(name).toLowerCase();
      const okExt = type === "video"
        ? [".mp4", ".webm", ".mov"].includes(ext)
        : IMAGE_EXT.has(ext);
      if (!okExt) throw new Error(`不支持的${type === "video" ? "视频" : "图片"}格式: ${ext || "(无扩展名)"}`);
      await ensureDir(ASSETS_DIR);
      const dest = path.join(ASSETS_DIR, name);
      const ws = createWriteStream(dest);
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          ws.destroy();
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `文件超过限制（${type === "video" ? "300M" : "50M"}）` }));
          req.destroy();
          return;
        }
        ws.write(chunk);
      });
      req.on("end", () => {
        ws.end(async () => {
          const entry = { url: `/assets/${name}`, name, ts: Date.now() };
          await pushHistory(type, entry).catch(() => {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, url: entry.url, type, name, size: received }));
        });
      });
      req.on("error", () => { try { ws.destroy(); } catch {} });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
  }

  const wss = new WebSocketServer({ server: http });

  fan = {
    paneEvent(pane, type, payload) {
      const wire = { kind: "pane", pane, type, ts: Date.now(), payload };
      const s = JSON.stringify(wire);
      for (const c of wss.clients) if (c.readyState === 1) c.send(s);
    },
    broadcast(o) {
      const s = JSON.stringify(o);
      for (const c of wss.clients) if (c.readyState === 1) c.send(s);
    },
  };

  const projectList = () => ({ kind: "catalog", projects: [...projects.values()].map(projectPayload) });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(projectList()));

    socket.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const rid = msg._rid;
      const ack = (body) => socket.send(JSON.stringify({ kind: "ok", ...body, ...(rid ? { _rid: rid } : {}) }));
      const fail = (body) => socket.send(JSON.stringify({ kind: "err", ...body, ...(rid ? { _rid: rid } : {}) }));

      try {
        switch (msg.kind) {
          case "catalog": { ack(projectList()); return; }
          case "project:new": {
            if (!msg.dir) throw new Error("project:new requires dir");
            if (projects.size >= MAX_PROJECTS) throw new Error(`最多支持 ${MAX_PROJECTS} 个项目（5×5 网格）`);
            const proj = await createProject(msg.name, msg.dir);
            ack(projectPayload(proj));
            fan.broadcast(projectList());
            return;
          }
          case "session:new": {
            // create a session only (NO pane opened)
            const proj = projects.get(msg.projectId);
            if (!proj) throw new Error(`unknown project: ${msg.projectId}`);
            if (proj.sessions.size >= MAX_PANES_PER_PROJECT) {
              throw new Error(`项目「${proj.name}」最多支持 ${MAX_PANES_PER_PROJECT} 个会话`);
            }
            const session = await createSession(proj.id, msg.name);
            ack({ sessionId: session.id, projectId: proj.id });
            fan.broadcast(projectList());
            return;
          }
          case "pane:new": {
            // create an EMPTY pane (no session bound, no pi process)
            const proj = projects.get(msg.projectId);
            if (!proj) throw new Error(`unknown project: ${msg.projectId}`);
            if (proj.panes.size >= MAX_PANES_PER_PROJECT) {
              throw new Error(`项目「${proj.name}」最多同时打开 ${MAX_PANES_PER_PROJECT} 个窗格`);
            }
            const paneKey = nextPaneKey();
            const pn = await startPane(paneKey, null, proj.id);
            ack({ pane: paneKey, projectId: proj.id, sessionId: null });
            fan.broadcast(projectList());
            return;
          }
          case "pane:bind": {
            // bind an existing pane to a session (1:1; restores history)
            const pn = await bindPane(msg.pane, msg.sessionId);
            ack({ pane: msg.pane, sessionId: msg.sessionId, running: pn.ready, error: pn.error });
            fan.broadcast(projectList());
            return;
          }
          case "pane:open": {
            // convenience: new pane + bind to an existing session (restore history)
            const session = sessions.get(msg.sessionId);
            if (!session) throw new Error(`unknown session: ${msg.sessionId}`);
            const proj = projects.get(session.projectId);
            const existing = [...proj.panes].find((pk) => panes.get(pk)?.sessionId === msg.sessionId);
            if (existing) { ack({ pane: existing, sessionId: msg.sessionId }); return; }
            if (proj.panes.size >= MAX_PANES_PER_PROJECT) {
              throw new Error(`项目「${proj.name}」最多同时打开 ${MAX_PANES_PER_PROJECT} 个窗格`);
            }
            const paneKey = nextPaneKey();
            await startPane(paneKey, null, proj.id); // register empty pane first
            const pn = await bindPane(paneKey, session.id);
            ack({ pane: paneKey, sessionId: session.id, running: pn.ready, error: pn.error });
            fan.broadcast(projectList());
            return;
          }
          case "pane:close": {
            // close pane only; the session stays alive (data persisted)
            const pn = panes.get(msg.pane);
            if (!pn) throw new Error(`unknown pane: ${msg.pane}`);
            const proj = projects.get(pn.projectId);
            if (pn.client) pn.client.stop();
            panes.delete(msg.pane);
            if (proj) proj.panes.delete(msg.pane);
            ack({ pane: msg.pane, sessionId: pn.sessionId });
            fan.broadcast(projectList());
            return;
          }
          case "session:delete": {
            const session = sessions.get(msg.sessionId);
            if (!session) throw new Error(`unknown session: ${msg.sessionId}`);
            const proj = projects.get(session.projectId);
            if (proj.sessions.size <= 1) throw new Error("项目至少保留 1 个会话");
            // close any pane bound to this session
            for (const pk of [...proj.panes]) {
              const pn = panes.get(pk);
              if (pn?.sessionId === msg.sessionId) { if (pn.client) pn.client.stop(); panes.delete(pk); proj.panes.delete(pk); }
            }
            // remove session dir + index
            await rm(session.sessionDir, { recursive: true, force: true }).catch(() => {});
            sessions.delete(msg.sessionId);
            proj.sessions.delete(msg.sessionId);
            await saveSessionIndex(proj);
            ack({ sessionId: msg.sessionId });
            fan.broadcast(projectList());
            return;
          }
          case "project:close": {
            const proj = projects.get(msg.projectId);
            if (!proj) throw new Error(`unknown project: ${msg.projectId}`);
            if (projects.size <= 1) throw new Error("至少保留 1 个项目");
            for (const p of [...proj.panes]) { const pn = panes.get(p); if (pn?.client) pn.client.stop(); panes.delete(p); }
            // delete all session files + index on disk
            await rm(path.join(SESSIONS_ROOT, proj.id), { recursive: true, force: true }).catch(() => {});
            await rm(indexFile(proj.id), { force: true }).catch(() => {});
            for (const s of [...proj.sessions]) sessions.delete(s);
            projects.delete(proj.id);
            ack({ projectId: proj.id });
            fan.broadcast(projectList());
            return;
          }
          case "prompt": {
            const p = panes.get(msg.pane);
            if (!p) throw new Error(`unknown pane: ${msg.pane}`);
            if (!p.client) throw new Error("该窗格未关联会话，先点「⌗」绑定一个会话");
            await p.client.prompt(msg.message);
            ack({ pane: msg.pane });
            return;
          }
          case "get_messages": {
            const p = panes.get(msg.pane);
            if (!p || !p.client) { ack({ pane: msg.pane, messages: [] }); return; }
            const r = await p.client.get_messages();
            ack({ pane: msg.pane, messages: r.data?.messages ?? [] });
            return;
          }
          case "abort": {
            const p = panes.get(msg.pane);
            if (!p || !p.client) { ack({ pane: msg.pane }); return; }
            await p.client.abort();
            ack({ pane: msg.pane });
            return;
          }
          case "new_session": {
            const p = panes.get(msg.pane);
            if (!p || !p.client) { ack({ pane: msg.pane }); return; }
            await p.client.new_session();
            ack({ pane: msg.pane });
            return;
          }
          case "stats": {
            const p = panes.get(msg.pane);
            if (!p || !p.client) { ack({ pane: msg.pane, stats: null }); return; }
            const r = await p.client.send({ type: "get_session_stats" });
            ack({ pane: msg.pane, stats: r.data ?? null });
            return;
          }
          case "fs:list": {
            if (!panes.has(msg.pane)) throw new Error(`unknown pane: ${msg.pane}`);
            const dir = resolveInProject(msg.pane, msg.path || "");
            const dirents = await readdir(dir, { withFileTypes: true });
            const entries = await Promise.all(dirents.map(async (d) => {
              const full = path.join(dir, d.name);
              const st = await stat(full);
              return { name: d.name, type: st.isDirectory() ? "dir" : "file", size: st.size };
            }));
            entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
            ack({ pane: msg.pane, path: msg.path || "", entries });
            return;
          }
          case "fs:dirs": {
            if (msg.path === "__roots__") {
              // list all available Windows drive roots (cross-drive browsing)
              const drives = [];
              if (process.platform === "win32") {
                for (let c = 65; c <= 90; c++) {
                  const letter = String.fromCharCode(c);
                  const root = `${letter}:\\`;
                  if (existsSync(root)) drives.push({ name: `${letter}:\\`, path: root });
                }
              } else {
                drives.push({ name: "/", path: "/" });
              }
              ack({ path: "__roots__", parent: null, drives });
              return;
            }
            const cur = msg.path && msg.path.length ? path.resolve(msg.path) : (process.env.HOME || path.dirname(ROOT));
            const st = await stat(cur).catch(() => null);
            if (!st || !st.isDirectory()) throw new Error("not a directory: " + cur);
            const dirents = await readdir(cur, { withFileTypes: true });
            const dirs = dirents
              .filter((d) => d.isDirectory() && !d.name.startsWith("."))
              .map((d) => ({ name: d.name, path: path.join(cur, d.name) }))
              .sort((a, b) => a.name.localeCompare(b.name));
            const parsed = path.parse(cur);
            // On Windows, a drive root (e.g. C:\) has no meaningful parent; offer roots instead.
            const isRoot = parsed.root === cur || (process.platform === "win32" && cur.length <= 3 && /^[A-Za-z]:$/.test(cur));
            let parent = isRoot ? null : path.dirname(cur);
            if (parent === cur) parent = isRoot ? null : path.dirname(parent);
            ack({ path: cur, parent, dirs, isRoot });
            return;
          }
          case "fs:read": {
            if (!panes.has(msg.pane)) throw new Error(`unknown pane: ${msg.pane}`);
            const file = resolveInProject(msg.pane, msg.path || "");
            const st = await stat(file);
            if (st.isDirectory()) throw new Error("is a directory");
            const ext = path.extname(file).toLowerCase();
            if (IMAGE_EXT.has(ext)) {
              const buf = await readFile(file);
              ack({ pane: msg.pane, path: msg.path, ftype: "image", mime: mimeFor(ext), data64: buf.toString("base64"), size: st.size });
            } else {
              let text; let truncated = false;
              if (st.size > MAX_PREVIEW_BYTES) {
                const buf = await readFile(file);
                text = buf.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
                truncated = true;
              } else {
                text = await readFile(file, "utf8");
              }
              ack({ pane: msg.pane, path: msg.path, ftype: "text", text, truncated, size: st.size });
            }
            return;
          }
          case "ref:create": {
            const e = await lib.create(msg);
            ack({ pane: msg.pane, id: e.id, ref: e });
            return;
          }
          case "ref:list": {
            ack({ kind: "refs", refs: await lib.list() });
            return;
          }
          case "ref:render": {
            const e = await lib.get(msg.id);
            ack({ kind: "refblock", id: msg.id, block: e ? lib.renderBlock(e) : null });
            return;
          }
          default:
            fail({ message: `unknown kind: ${msg.kind}` });
        }
      } catch (err) {
        fail({ message: err.message });
      }
    });
  });

  // ---- boot: one seed project (real cwd) with one pane ----
  const seedProj = await createProject(path.basename(DEFAULT_PROJECT_DIR), DEFAULT_PROJECT_DIR);

  http.listen(PORT, HOST, () => {
    console.log(`\n  Workflow M4 listening on http://${HOST}:${PORT}`);
    console.log(`  seed project : ${seedProj.name} → ${seedProj.dir}`);
    console.log(`  sessions dir : ${SESSIONS_ROOT}`);
    console.log(`  reference lib: ${LIB_DIR}\n`);
  });

  // Stop every pane child then exit. Used by SIGINT/SIGTERM (Ctrl+C) and the
  // /shutdown endpoint, so `/workflow stop` can shut down gracefully without
  // leaving orphaned `pi --mode rpc` processes behind.
  function shutdown() {
    for (const [, pn] of panes) { if (pn.client) pn.client.stop(); }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
