/* ============================================================
 * Workflow — M4 client (project groups + per-project panes)
 *
 * Layout:
 *   left rail  = project tree (projects → panes) + file manager (active project dir)
 *   center     = tab bar (active project's panes, fixed row) + tiling split
 *   right rail = file preview (drag-resizable)
 *
 * Model:
 *   project = { id, name, dir, panes:[{pane,running,error}] }
 *   each pane belongs to exactly one project; pane's cwd = project.dir
 *   every project >= 1 pane, <= 9 panes (server enforced)
 *   a split layout tree is remembered PER project.
 * ============================================================ */

const LKEY = "workflow.layout.v2";       // map projectId -> tree
const BG_KEY = "workflow.bg";
const COLS_KEY = "workflow.gridCols";
const ACT_KEY = "workflow.activity.v1";
const MAX_PANES = 9;
const MAX_PROJECTS = 25; // control-home card wall = 5x5 grid

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

const state = {
  ws: null,
  projects: new Map(),        // id -> {id,name,dir,panes:[...]}
  activity: new Map(),        // pane -> {status,tool,preview,needsEol,t}
  activeProject: null,        // project id
  activePane: null,           // pane key
  layouts: loadLayouts(),     // projectId -> split tree
  fs: { pane: null, path: "", entries: [] },
  previewW: 390,
  projectMode: "cards",       // 'cards' | 'list'
  expanded: new Set(),        // expanded project ids (card mode)
  previewOpen: false,         // right preview rail expanded?
  leftOpen: true,             // left rail expanded?
  view: "control",            // 'control' (home card wall) | 'workbench'
  bg: loadBg(),               // {type:'default'|'image'|'video', url?}
  gridCols: loadGridCols(),   // control-home grid column count (2..8)
};

/* ---------- tree helpers (split layout) ---------- */
function mkLeaf(pane = null) { return { t: "leaf", pane }; }
function mkSplit(dir, a, b, ratio = 0.5) { return { t: "split", dir, ratio, a, b }; }
function collect(n, out = []) { if (!n) return out; if (n.t === "leaf") { out.push(n); return out; } collect(n.a, out); collect(n.b, out); return out; }
function curLayout() {
  if (!state.activeProject) return null;
  if (!state.layouts.has(state.activeProject)) state.layouts.set(state.activeProject, null);
  return state.layouts.get(state.activeProject);
}
function setLayout(t) { if (state.activeProject) state.layouts.set(state.activeProject, t); }
function allLeaves() { return collect(curLayout()); }
function hosted() { return new Set(allLeaves().map((l) => l.pane).filter(Boolean)); }
function parentOf(n) {
  let hit = null;
  (function walk(x, p) { if (x.t === "split") { if (x.a === n || x.b === n) { hit = x; return; } walk(x.a, x); if (!hit) walk(x.b, x); } })(curLayout(), null);
  return hit;
}
function placeAt(n, nc) { const p = parentOf(n); if (!p) { setLayout(nc); return; } if (p.a === n) p.a = nc; else p.b = nc; }
function splitLeaf(leaf, dir) { const fresh = mkLeaf(null); placeAt(leaf, mkSplit(dir, leaf, fresh, 0.6)); return fresh; }
function dropLeaf(leaf) { const p = parentOf(leaf); if (!p) { setLayout(mkLeaf(null)); return; } placeAt(p, p.a === leaf ? p.b : p.a); }
function leafInLayout(l) { return allLeaves().includes(l); }

/* ---------- persistence ---------- */
function loadLayouts() { try { const raw = localStorage.getItem(LKEY); if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return new Map(Object.entries(o)); } } catch {} return new Map(); }
function persistLayouts() { try { localStorage.setItem(LKEY, JSON.stringify(Object.fromEntries(state.layouts))); } catch {} }
function loadActivity() { try { const raw = localStorage.getItem(ACT_KEY); if (raw) for (const [p, v] of Object.entries(JSON.parse(raw))) state.activity.set(p, { status: v.status, tool: v.tool || "", preview: v.preview || "", needsEol: v.needsEol || "", t: 0 }); } catch {} }
function persistActivity() { try { const o = {}; for (const [p, a] of state.activity) o[p] = { status: a.status, tool: a.tool, preview: a.preview, needsEol: a.needsEol }; localStorage.setItem(ACT_KEY, JSON.stringify(o)); } catch {} }

/* ---- control-home background + grid config ---- */
function loadBg() { try { const v = JSON.parse(localStorage.getItem(BG_KEY)); return v && typeof v.type === "string" ? v : { type: "default" }; } catch { return { type: "default" }; } }
function loadGridCols() { try { const n = parseInt(localStorage.getItem(COLS_KEY), 10); return n >= 2 && n <= 8 ? n : 5; } catch { return 5; } }
function persistBg() { try { localStorage.setItem(BG_KEY, JSON.stringify(state.bg)); } catch {} }
function persistCols() { try { localStorage.setItem(COLS_KEY, String(state.gridCols)); } catch {} }

function actInit(pane) { if (!state.activity.has(pane)) state.activity.set(pane, { status: "idle", tool: "", preview: "", needsEol: "", t: 0 }); return state.activity.get(pane); }
const statusOf = (p) => actInit(p).status || "idle";

/* ==================== SERVER COMMS ==================== */
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;
  ws.onopen = () => send({ kind: "catalog" });
  ws.onmessage = (e) => { try { handleWs(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => setTimeout(connect, 1000);
}
function send(o) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); }
const _rr = new Map();
function rpc(kind, payload = {}) { return new Promise((resolve) => { const rid = "r" + Math.random().toString(36).slice(2, 10); _rr.set(rid, resolve); send({ kind, ...payload, _rid: rid }); }); }

function handleWs(p) {
  if (p.kind === "catalog") { onCatalog(p.projects); return; }
  if (p.kind === "ok") { if (p._rid && _rr.has(p._rid)) { const r = _rr.get(p._rid); _rr.delete(p._rid); r(p); } return; }
  if (p.kind === "err") { toast(p.message || "server error", true); return; }
  if (p.kind === "refs") { renderRefs(p.refs); return; }
  if (p.kind === "pane") { consumePaneEvent(p); return; }
}

function sessionOfPane(paneKey) {
  for (const proj of state.projects.values()) {
    const pn = proj.panes?.find((p) => p.pane === paneKey);
    if (pn) return pn.sessionId;
  }
  return null;
}

function pruneStalePanes() {
  // collect valid pane keys from backend catalog
  const valid = new Set();
  for (const proj of state.projects.values()) for (const pn of proj.panes || []) valid.add(pn.pane);
  // clear any leaf whose pane no longer exists server-side (pane is ephemeral)
  for (const [pid, lay] of state.layouts) {
    for (const l of collect(lay)) {
      if (l.pane && !valid.has(l.pane)) l.pane = null;
    }
  }
}

function onCatalog(projects) {
  state.projects = new Map(projects.map((p) => [p.id, p]));
  for (const proj of projects) {
    for (const s of proj.sessions || []) actInit(s.id); // track status per session
  }
  // keep activeProject if still present
  if (!state.activeProject || !state.projects.has(state.activeProject)) {
    state.activeProject = projects[0]?.id ?? null;
  }
  if (state.expanded.size === 0 && state.activeProject) state.expanded.add(state.activeProject);
  pruneStalePanes();
  const proj = state.projects.get(state.activeProject);
  const panes = proj ? (proj.panes || []).map((p) => p.pane) : [];
  if (!panes.includes(state.activePane)) state.activePane = panes[0] ?? null;
  render(); loadFileTree();
}

/* ==================== RENDER ==================== */
function render() {
  renderProjectTree();
  renderTabbar();
  // center: control-home (card wall) OR workbench (tabs + split panes)
  const isControl = state.view === "control";
  const ch = $("#control-home"); const wb = $("#workbench");
  if (ch) ch.classList.toggle("active", isControl);
  if (wb) wb.classList.toggle("active", !isControl);
  if (isControl) renderControlHome();
  else renderCenter();
  repaintCounts();
}

/* ---- control home: project card wall ---- */
function renderControlHome() {
  const host = $("#control-home"); if (!host) return;
  host.innerHTML = "";
  if (!state.projects.size) { host.appendChild(el("div", "cr-empty", "还没有项目，点左侧「＋」新建一个")); return; }
  const grid = el("div", "ch-grid");
  for (const proj of state.projects.values()) {
    grid.appendChild(renderHomeCard(proj));
  }
  host.appendChild(grid);
  applyGridCols();
}
function renderHomeCard(proj) {
  const card = el("div", "ch-card");
  card.classList.toggle("active", proj.id === state.activeProject);
  // aggregate status over sessions
  const sts = (proj.sessions || []).map((s) => statusOf(s.id));
  if (sts.includes("needs")) card.classList.add("has-wait");
  else if (sts.includes("working")) card.classList.add("has-work");
  const head = el("div", "ch-head");
  head.append(el("span", "ch-ico", "🗂"), el("span", "ch-name", proj.name));
  card.appendChild(head);
  const dirline = el("div", "ch-dir", proj.dir);
  dirline.title = proj.dir;
  card.appendChild(dirline);
  // per-session status dots
  const row = el("div", "ch-panes");
  for (const s of proj.sessions || []) {
    const p = el("div", "ch-pane");
    const dot = el("span", "ch-dot st-" + statusOf(s.id));
    const label = el("span", "ch-pane-label", "会话 " + s.id.toUpperCase());
    p.append(dot, label);
    row.appendChild(p);
  }
  card.appendChild(row);
  const foot = el("div", "ch-foot");
  foot.append(el("span", "ch-count", `${(proj.sessions || []).length} 会话`), el("span", "ch-open", "进入 →"));
  card.appendChild(foot);
  card.onclick = () => openProjectFromHome(proj.id);
  return card;
}
function openProjectFromHome(id) {
  state.activeProject = id;
  const proj = state.projects.get(id);
  state.activePane = (proj?.panes || [])[0]?.pane ?? null;
  state.view = "workbench";
  render(); loadFileTree();
}
function setView(v) {
  state.view = v;
  const c = $("#view-control"), w = $("#view-workbench");
  if (c) c.classList.toggle("active", v === "control");
  if (w) w.classList.toggle("active", v === "workbench");
  const dock = $("#control-dock");
  if (dock) dock.classList.toggle("active", v === "control");
  render();
  if (v === "control") { applyBackground(); applyGridCols(); }
}

/* ---- control-home background (default blueprint / image / video) ---- */
function applyBackground() {
  const app = $("#app"); if (!app) return;
  const host = $("#control-home");
  // clear injected video layer on app
  app.querySelectorAll(".bg-video-layer").forEach((n) => n.remove());
  const type = state.bg?.type || "default";
  document.body.dataset.bgtype = type; // drive glass panels via CSS
  if (type === "image" && state.bg.url) {
    app.style.backgroundImage = `url("${state.bg.url}")`;
    app.style.backgroundSize = "cover";
    app.style.backgroundPosition = "center";
    if (host) { host.style.backgroundImage = "none"; host.style.background = "none"; }
    sampleImageColor(state.bg.url).then((c) => { if (c) applyRailTint(c); });
  } else if (type === "video" && state.bg.url) {
    app.style.backgroundImage = "none";
    const v = document.createElement("video");
    v.className = "bg-video-layer";
    v.src = state.bg.url;
    v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
    v.crossOrigin = "anonymous";
    app.prepend(v);
    if (host) { host.style.backgroundImage = "none"; host.style.background = "none"; }
    v.addEventListener("loadeddata", () => sampleVideoColor(v).then((c) => { if (c) applyRailTint(c); }), { once: true });
  } else {
    app.style.backgroundImage = "";
    app.style.backgroundSize = "";
    app.style.backgroundPosition = "";
    // restore control-home's blueprint background (inline style was cleared for custom bg)
    if (host) { host.style.background = ""; host.style.backgroundImage = ""; host.style.backgroundSize = ""; host.style.backgroundPosition = ""; }
    document.documentElement.style.setProperty("--rail-tint", "");
    document.documentElement.style.setProperty("--glass-tint", "");
  }
  // sync menu items + button label
  const btn = $("#bg-menu-btn");
  if (btn) {
    const label = type === "default" ? "🖼 背景设定 ▾" : type === "image" ? "🖼 图片 ▾" : type === "video" ? "🎬 动态 ▾" : "🖼 背景设定 ▾";
    btn.textContent = label;
  }
  for (const act of ["default", "image", "video"]) {
    const item = $(`.bg-item[data-act="${act}"]`);
    if (item) item.classList.toggle("active", act === type);
  }
  const customBtn = $(`.bg-item[data-act="custom"]`);
  if (customBtn) customBtn.classList.toggle("active", type !== "default");
}

/* sample edge-dominant color from an image or video frame */
function sampleImageColor(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(sampleFromImage(img));
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
function sampleVideoColor(video) {
  return new Promise((resolve) => {
    try { resolve(sampleFromImage(video)); } catch { resolve(null); }
  });
}
function sampleFromImage(src) {
  try {
    const w = 40, h = 40;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    // average the edge ring (2px) — picks up the photo's border/background tone
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const edge = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
      if (!edge) continue;
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  } catch { return null; }
}
function applyRailTint({ r, g, b }) {
  document.documentElement.style.setProperty("--rail-tint", `rgba(${r},${g},${b},0.55)`);
  document.documentElement.style.setProperty("--glass-tint", `rgba(${r},${g},${b},0.14)`);
}
function applyGridCols() {
  const grid = $(".ch-grid"); if (!grid) return;
  grid.style.gridTemplateColumns = `repeat(${state.gridCols}, 224px)`;
  grid.style.maxWidth = "";
  const val = $(`#grid-cols-val`); if (val) val.textContent = `${state.gridCols} 列`;
  const slider = $(`#grid-cols`); if (slider) slider.value = String(state.gridCols);
}

/* ---- background upload ---- */
async function uploadBgFile(file, type) {
  if (!file) return;
  const max = type === "video" ? 300 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > max) { toast(`文件超过限制（${type === "video" ? "300M" : "50M"}）`, true); return; }
  // keep extension
  const name = `${type}-${Date.now()}${extOf(file.name)}`;
  toast(`正在上传 ${(file.size / 1048576).toFixed(1)} MB …`, false);
  try {
    const r = await fetch(`/upload-bg?type=${type}&name=${encodeURIComponent(name)}`, { method: "POST", body: file });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "上传失败", true); return; }
    state.bg = { type, url: j.url };
    persistBg();
    applyBackground();
    loadBgHistory();
    toast("背景已更新", false);
  } catch (err) {
    toast("上传失败: " + err.message, true);
  }
}
function extOf(name) { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i) : ""; }

/* ---- background history (last 10 images / 5 videos) ---- */
async function loadBgHistory() {
  const imgHost = $("#bg-hist-images");
  const vidHost = $("#bg-hist-videos");
  try {
    const r = await fetch("/bg-history");
    const h = await r.json();
    renderHist(imgHost, h.images || [], "image");
    renderHist(vidHost, h.videos || [], "video");
  } catch {
    if (imgHost) imgHost.innerHTML = "";
    if (vidHost) vidHost.innerHTML = "";
  }
}
function renderHist(host, list, type) {
  if (!host) return;
  host.innerHTML = "";
  if (!list.length) { host.appendChild(el("div", "bg-hist-empty", "（无历史）")); return; }
  for (const e of list) {
    const item = el("div", "bg-hist-item");
    if (type === "image") {
      const img = el("img", "bg-hist-thumb", "");
      img.src = e.url;
      img.loading = "lazy";
      img.title = e.url;
      item.appendChild(img);
    } else {
      const v = el("span", "bg-hist-thumb video", "🎬");
      v.title = e.url;
      item.appendChild(v);
    }
    item.classList.toggle("active", state.bg?.url === e.url);
    item.onclick = () => { state.bg = { type, url: e.url }; persistBg(); applyBackground(); };
    host.appendChild(item);
  }
}

/* ---- left: project tree (projects → sessions) ---- */
function renderProjectTree() {
  const host = $("#project-tree"); if (!host) return;
  host.innerHTML = "";
  host.classList.toggle("card-mode", state.projectMode === "cards");
  host.classList.toggle("list-mode", state.projectMode === "list");
  if (!state.projects.size) { host.appendChild(el("div", "pt-empty", "还没有项目")); return; }
  for (const proj of state.projects.values()) {
    if (state.projectMode === "cards") {
      host.appendChild(renderProjectCard(proj));
    } else {
      host.appendChild(renderProjectRow(proj));
      const plist = el("div", "pt-list");
      for (const s of proj.sessions || []) plist.appendChild(renderSessionRow(proj, s));
      plist.appendChild(renderAddSessionBtn());
      host.appendChild(plist);
    }
  }
}
function renderAddSessionBtn() {
  const b = el("div", "pt-add-session", "＋ 新建会话");
  b.onclick = () => newSessionOnly();
  return b;
}
function renderProjectCard(proj) {
  const expanded = state.expanded.has(proj.id);
  const card = el("div", "pt-card");
  card.classList.toggle("active", proj.id === state.activeProject);
  const head = el("div", "pt-card-head");
  head.append(el("span", "pt-ico", "🗂"), el("span", "pt-name", proj.name), el("span", "pt-pcount", String((proj.sessions || []).length)));
  const arrow = el("span", "pt-arrow", expanded ? "▾" : "▸");
  head.appendChild(arrow);
  if (state.projects.size > 1) { const x = el("span", "pt-close", "✕"); x.title = "关闭项目"; x.onclick = (e) => { e.stopPropagation(); closeProject(proj.id); }; head.appendChild(x); }
  head.onclick = () => { if (state.activeProject !== proj.id) { state.activeProject = proj.id; state.activePane = (proj.panes || [])[0]?.pane ?? null; } if (expanded) state.expanded.delete(proj.id); else state.expanded.add(proj.id); renderProjectTree(); renderTabbar(); renderCenter(); loadFileTree(); };
  card.appendChild(head);
  if (expanded) {
    const body = el("div", "pt-card-body");
    for (const s of proj.sessions || []) body.appendChild(renderSessionRow(proj, s));
    body.appendChild(renderAddSessionBtn());
    card.appendChild(body);
  }
  return card;
}
function renderProjectRow(proj) {
  const row = el("div", "pt-proj");
  row.classList.toggle("active", proj.id === state.activeProject);
  row.append(el("span", "", "🗂"), el("span", "pt-name", proj.name), el("span", "pt-pcount", String((proj.sessions || []).length)));
  if (state.projects.size > 1) { const x = el("span", "pt-close", "✕"); x.title = "关闭项目"; x.onclick = (e) => { e.stopPropagation(); closeProject(proj.id); }; row.appendChild(x); }
  row.onclick = () => selectProject(proj.id);
  return row;
}
function renderSessionRow(proj, s) {
  const openedPane = s.openPane;
  const pr = el("div", "pt-pane");
  pr.classList.toggle("active", openedPane != null && openedPane === state.activePane);
  pr.append(el("span", "pt-status st-" + statusOf(s.id)), el("span", "pt-pname", `会话 ${s.id.toUpperCase()}`));
  const del = el("span", "pt-del", "");
  del.title = "删除会话";
  del.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  del.onclick = (e) => { e.stopPropagation(); confirmDeleteSession(s.id, del); };
  pr.appendChild(del);
  pr.onclick = () => { if (openedPane != null) selectPane(openedPane); else openSession(s.id); };
  return pr;
}
function selectProject(id) {
  state.activeProject = id;
  const proj = state.projects.get(id);
  state.activePane = (proj?.panes || [])[0]?.pane ?? null;
  state.view = "workbench";
  render(); loadFileTree();
}
function selectPane(pane) {
  state.activePane = pane;
  state.view = "workbench";
  ensurePaneInLayout(pane);
  persistLayouts();
  render(); loadFileTree();
}
function ensurePaneInLayout(paneKey) {
  // make sure the pane has a leaf in the layout so it renders + loads history
  const leaves = allLeaves();
  if (leaves.some((l) => l.pane === paneKey)) return;
  const empty = leaves.find((l) => !l.pane);
  if (empty) { empty.pane = paneKey; return; }
  // no empty leaf: replace the active leaf (or first leaf) with this pane
  const target = leaves.find((l) => l.pane === state.activePane) || leaves[0];
  if (target) target.pane = paneKey;
  else setLayout(mkLeaf(paneKey));
}
async function openSession(sessionId) {
  const r = await rpc("pane:open", { sessionId });
  if (r && r.pane) {
    await refreshCatalog();
    // host the newly opened pane in the layout: reuse current active leaf, else first leaf
    const leaves = allLeaves();
    let leaf = leaves.find((l) => l.pane === state.activePane) || leaves.find((l) => !l.pane) || leaves[0];
    if (leaf) { leaf.pane = r.pane; }
    else { setLayout(mkLeaf(r.pane)); }
    state.activePane = r.pane;
    state.view = "workbench";
    persistLayouts();
    render(); loadFileTree();
  }
}
async function deleteSession(sessionId) {
  const r = await rpc("session:delete", { sessionId });
  if (r) { await refreshCatalog(); render(); loadFileTree(); }
}
function confirmDeleteSession(sessionId, anchorEl) {
  // custom confirm popover near the delete control
  const pop = el("div", "confirm-pop");
  const msg = el("div", "confirm-msg", "删除该会话？记录将永久删除，不可恢复。");
  const btns = el("div", "confirm-btns");
  const ok = el("button", "confirm-ok", "删除");
  ok.onclick = async (e) => { e.stopPropagation(); pop.remove(); await deleteSession(sessionId); };
  const cancel = el("button", "confirm-cancel", "取消");
  cancel.onclick = (e) => { e.stopPropagation(); pop.remove(); };
  btns.append(ok, cancel);
  pop.append(msg, btns);
  // position near the anchor (right side of the session row)
  const r = anchorEl.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 80) + "px";
  pop.style.left = Math.max(8, r.right - 220) + "px";
  document.body.appendChild(pop);
  // close when clicking elsewhere
  const closer = (e) => { if (!pop.contains(e.target) && !anchorEl.contains(e.target)) { pop.remove(); document.removeEventListener("click", closer); } };
  setTimeout(() => document.addEventListener("click", closer), 0);
}
async function closeProject(id) {
  const r = await rpc("project:close", { projectId: id });
  if (r) { onCatalog(await (await rpc("catalog")).projects); }
}

/* ---- center: tabbar (open panes, bound to sessions) ---- */
function renderTabbar() {
  const bar = $("#tabbar"); if (!bar) return;
  bar.innerHTML = "";
  const proj = state.projects.get(state.activeProject);
  if (!proj) return;
  for (const pn of proj.panes || []) {
    const t = el("div", "tab");
    t.classList.toggle("active", pn.pane === state.activePane);
    const sessLabel = pn.sessionId ? "🔗" + pn.sessionId.toUpperCase() : "未关联";
    t.append(el("span", "t-status st-" + (pn.sessionId ? statusOf(pn.sessionId) : "idle")), el("span", "", `窗格 ${pn.pane.toUpperCase()}`), el("span", "t-sess", sessLabel));
    const c = el("span", "t-close", "✕"); c.title = "关闭窗格(会话保留)"; c.onclick = (e) => { e.stopPropagation(); closePane(pn.pane); }; t.appendChild(c);
    t.onclick = () => selectPane(pn.pane);
    bar.appendChild(t);
  }
  const add = el("button", "tab-add", "＋");
  add.title = "分屏（上下/左右）";
  add.onclick = () => showSplitMenu();
  bar.appendChild(add);
}
async function closePane(pane) {
  const r = await rpc("pane:close", { pane });
  if (r) {
    await refreshCatalog();
    // clear any leaf that hosted this closed pane
    for (const l of allLeaves()) if (l.pane === pane) l.pane = null;
    if (state.activePane === pane) {
      const proj = state.projects.get(state.activeProject);
      state.activePane = (proj?.panes || [])[0]?.pane ?? null;
    }
    persistLayouts();
    render(); loadFileTree();
  }
}
async function newSessionOnly() {
  // create a session only (no pane)
  if (!state.activeProject) return;
  const proj = state.projects.get(state.activeProject);
  if ((proj.sessions || []).length >= MAX_PANES) { toast(`项目「${proj.name}」最多 ${MAX_PANES} 个会话`, true); return; }
  const r = await rpc("session:new", { projectId: state.activeProject });
  if (r && r.sessionId) { await refreshCatalog(); render(); }
}
async function newProject() {
  if (state.projects.size >= MAX_PROJECTS) { toast(`最多支持 ${MAX_PROJECTS} 个项目（5×5 网格）`, true); return; }
  const chosen = await openDirPicker();
  if (!chosen) return;
  const name = chosen.split(/[\\/]/).pop() || chosen;
  const r = await rpc("project:new", { dir: chosen, name });
  if (r && r.id) { await refreshCatalog(); state.activeProject = r.id; state.activePane = r.panes?.[0]?.pane ?? null; render(); loadFileTree(); }
}

/* ---- centered directory picker modal (browse filesystem, read-only) ---- */
async function openDirPicker() {
  return new Promise((resolve) => {
    const mask = el("div", "modal-mask");
    const box = el("div", "modal");
    const head = el("div", "modal-head");
    head.append(el("span", "m-title", "选择项目目录"));
    const x = el("button", "m-x", "✕"); x.onclick = () => { mask.remove(); resolve(null); };
    head.appendChild(x);

    // manual path bar (supports any drive/absolute path)
    const pathBar = el("div", "m-pathbar");
    const pathInput = document.createElement("input");
    pathInput.className = "m-path-input";
    pathInput.placeholder = "手动输入目录地址（如 /Users/you/project 或 E:/Project）";
    const goBtn = el("button", "m-go", "跳转");
    goBtn.onclick = () => { const v = pathInput.value.trim(); if (v) load(v); };
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goBtn.onclick(); });
    const drivesBtn = el("button", "m-go", "💾 盘符");
    drivesBtn.title = "列出所有可用磁盘驱动器";
    drivesBtn.onclick = () => load("__roots__");
    pathBar.append(pathInput, goBtn, drivesBtn);

    const crumb = el("div", "m-crumb", "…");
    crumb.title = "当前目录";
    const body = el("div", "m-body");
    const foot = el("div", "modal-foot");
    const cancel = el("button", "", "取消"); cancel.onclick = () => { mask.remove(); resolve(null); };
    const ok = el("button", "", "选择此目录");
    ok.onclick = () => { const v = crumb.dataset.path; if (v) { mask.remove(); resolve(v); } };
    foot.append(cancel, ok);
    box.append(head, pathBar, crumb, body, foot);
    mask.appendChild(box);
    document.body.appendChild(mask);

    async function load(path) {
      const r = await rpc("fs:dirs", { path });
      if (!r || !r.path) { body.innerHTML = `<div class="m-empty">无法读取该目录</div>`; return; }
      const isRoots = r.path === "__roots__";
      crumb.textContent = isRoots ? "选择驱动器" : r.path;
      crumb.dataset.path = isRoots ? "" : r.path;
      ok.disabled = !isRoots ? false : true;
      pathInput.value = isRoots ? "" : r.path;
      body.innerHTML = "";
      if (r.drives && r.drives.length) {
        for (const d of r.drives) {
          const row = el("button", "m-dir drive", "💾 " + d.name);
          row.title = d.path;
          row.onclick = () => load(d.path);
          body.appendChild(row);
        }
        return;
      }
      if (r.isRoot) {
        const roots = el("button", "m-dir up", "💾 选择驱动器…");
        roots.onclick = () => load("__roots__");
        body.appendChild(roots);
      } else if (r.parent) {
        const up = el("button", "m-dir up", "⬆ ..");
        up.onclick = () => load(r.parent);
        body.appendChild(up);
      }
      if (!r.dirs?.length) { body.appendChild(el("div", "m-empty", "（无子目录）")); }
      for (const d of r.dirs) {
        const row = el("button", "m-dir", "📁 " + d.name);
        row.title = d.path;
        row.onclick = () => load(d.path);
        body.appendChild(row);
      }
    }
    load("");
  });
}
async function refreshCatalog() {
  const r = await rpc("catalog");
  if (r && Array.isArray(r.projects)) onCatalog(r.projects);
}

/* ---- center: split area ---- */
function renderCenter() {
  const main = $("#panes"); if (!main) return;
  main.innerHTML = "";
  let lay = curLayout();
  // build default layout for current project if none: one leaf per pane, tiled vertically? default single-pane tree
  const proj = state.projects.get(state.activeProject);
  if (!proj) { main.appendChild(el("div", "pt-empty", "新建或选择一个项目")); return; }
  if (!lay || !allLeavesFrom(lay).length) {
    lay = mkLeaf((proj.panes || [])[0]?.pane ?? null);
    setLayout(lay);
  }
  // ensure every pane has a leaf? leave it: panes not in layout are reachable via tabs (they get auto-hosted on click)
  main.appendChild(renderNode(lay));
  highlightActiveLeaf();
  // load persisted history for every bound pane (history is server-side, not just streamed)
  for (const l of allLeavesFrom(lay)) {
    if (l.pane) loadHistoryForPane(l.pane);
  }
}

async function loadHistoryForPane(paneKey) {
  const sec = $$("section.pane").find((s) => s.dataset.pane === paneKey);
  if (!sec) return;
  const logEl = $(".log", sec);
  if (!logEl) return;
  const r = await rpc("get_messages", { pane: paneKey });
  if (!r || !Array.isArray(r.messages)) return;
  // only fill if still empty (avoid clobbering live stream)
  if (logEl.children.length > 0) return;
  for (const m of r.messages) {
    if (m.role === "user") addMsg(sec, "user", extractText(m), { who: `你 · 窗格${paneKey.toUpperCase()}` });
    else if (m.role === "assistant") addMsg(sec, "assistant", extractText(m));
    else if (m.role === "toolResult") addMsg(sec, "assistant", `[工具 ${m.toolName || ""}] ` + extractText(m));
    else if (m.role === "bashExecution") addMsg(sec, "assistant", `$ ${m.command || ""}\n${m.output || ""}`);
  }
}
function allLeavesFrom(n, out = []) { return collect(n, out); }

function renderNode(n) {
  if (n.t === "leaf") return renderLeaf(n);
  const wrap = el("div", "splitwrap");
  if (n.dir === "col") { wrap.style.gridTemplateColumns = `${pct(n.ratio)} 6px ${pct(1 - n.ratio)}`; wrap.style.gridTemplateRows = "1fr"; }
  else { wrap.style.gridTemplateRows = `${pct(n.ratio)} 6px ${pct(1 - n.ratio)}`; wrap.style.gridTemplateColumns = "1fr"; }
  const bar = el("div", n.dir === "col" ? "splitbar" : "splitbar row");
  bar.addEventListener("pointerdown", (e) => startCenterDrag(e, n, wrap));
  const ca = el("div", "cell"); ca.appendChild(renderNode(n.a));
  const cb = el("div", "cell"); cb.appendChild(renderNode(n.b));
  wrap.append(ca, bar, cb);
  return wrap;
}
const pct = (x) => `${Math.round(x * 10000) / 100}%`;

let cdrag = null;
function startCenterDrag(e, node, dom) { cdrag = { node, dom, dir: node.dir, x0: e.clientX, y0: e.clientY, r0: node.ratio }; document.body.classList.add("dragging"); window.addEventListener("pointermove", onCenterDrag); window.addEventListener("pointerup", endCenterDrag, { once: true }); e.preventDefault(); }
function onCenterDrag(e) { if (!cdrag) return; const rc = cdrag.dom.getBoundingClientRect(); const span = (cdrag.dir === "col" ? rc.width : rc.height) || 1; const d = cdrag.dir === "col" ? e.clientX - cdrag.x0 : e.clientY - cdrag.y0; cdrag.node.ratio = Math.max(0.08, Math.min(0.92, cdrag.r0 + d / span)); applyCenterRatio(cdrag.node, cdrag.dom); }
function endCenterDrag() { if (cdrag) persistLayouts(); cdrag = null; document.body.classList.remove("dragging"); window.removeEventListener("pointermove", onCenterDrag); }
function applyCenterRatio(n, dom) { if (n.dir === "col") dom.style.gridTemplateColumns = `${pct(n.ratio)} 6px ${pct(1 - n.ratio)}`; else dom.style.gridTemplateRows = `${pct(n.ratio)} 6px ${pct(1 - n.ratio)}`; }

/* ---- leaf view ---- */
function renderLeaf(leaf) {
  const sec = el("section", "pane");
  sec.dataset.pane = leaf.pane ?? "";
  sec._leaf = leaf;
  const head = el("div", "pane-head");
  head.onclick = (e) => { if (e.target.closest("button")) return; state.activePane = leaf.pane; state.activeLeaf = leaf; highlightActiveLeaf(); renderTabbar(); loadFileTree(); };
  const title = el("span", "pane-title", leaf.pane ? `窗格 ${leaf.pane.toUpperCase()}` : "空闲泊位");
  title.classList.toggle("empty", !leaf.pane);
  const sessId = leaf.pane ? sessionOfPane(leaf.pane) : null;
  const sess = el("span", "pane-sess", sessId ? ("🔗" + sessId.toUpperCase()) : "");
  sess.title = "此窗格绑定的会话";
  if (leaf.pane && !sessId) { sess.textContent = "未关联"; sess.classList.add("unbound"); }
  const proj = el("span", "pane-proj", state.projects.get(state.activeProject)?.name || "");
  const status = el("div", "pane-status"); const dot = el("span", "dot idle"); const stxt = el("span", "", "—");
  status.append(dot, stxt);
  const ctl = el("div", "pane-controls");
  const mkb = (label, tip, fn) => { const b = el("button", "ctl", label); b.title = tip; b.onclick = fn; ctl.appendChild(b); };
  mkb("⇄", "左右分屏", () => { state.activeLeaf = leaf; afterSplit(leaf, "col"); });
  mkb("⇅", "上下分屏", () => { state.activeLeaf = leaf; afterSplit(leaf, "row"); });
  mkb("⌗", "关联会话", () => pickFor(leaf));
  mkb("✕", "关闭视图", () => { if (leaf.pane) closePane(leaf.pane); else { dropLeaf(leaf); persistLayouts(); renderCenter(); } });
  head.append(status, title, sess, proj, ctl);

  const logBox = el("div", "log");
  const inputRow = el("div", "input-row");
  const ta = document.createElement("textarea");
  ta.placeholder = leaf.pane ? (sessionOfPane(leaf.pane) ? `发给 窗格${leaf.pane.toUpperCase()}…` : "未关联会话 · 点 ⌗ 绑定") : "该泊位未分配 · 点 ⌗";
  ta.disabled = !leaf.pane;
  const sendBtn = el("button", "", "发送"); sendBtn.disabled = !leaf.pane;
  const nsBtn = el("button", "", "新会话");
  const abBtn = el("button", "ctl-danger", "■ 中断");
  abBtn.title = "中断/停止当前会话正在执行的任务";
  inputRow.append(ta, sendBtn, nsBtn, abBtn);
  sec.append(head, logBox, inputRow);
  const errd = el("div", "err"); sec.appendChild(errd);

  function sendIt() { const txt = ta.value.trim(); if (!txt || !leaf.pane) return; ta.value = ""; pushUser(sec, txt); setBusy(sec, true, "working…"); send({ kind: "prompt", pane: leaf.pane, message: txt }); }
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  sendBtn.onclick = sendIt;
  abBtn.onclick = () => { if (leaf.pane) send({ kind: "abort", pane: leaf.pane }); setBusy(sec, false, "idle"); };
  nsBtn.onclick = () => { if (!leaf.pane) return; send({ kind: "new_session", pane: leaf.pane }); clearLog(sec); };

  syncHead(sec);
  return sec;
}
function syncHead(sec) {
  const leaf = sec._leaf; const pane = leaf.pane;
  const title = $(".pane-title", sec); if (title) { title.textContent = pane ? `窗格 ${pane.toUpperCase()}` : "空闲泊位"; title.classList.toggle("empty", !pane); }
  const sess = $(".pane-sess", sec); if (sess) { const sid = pane ? sessionOfPane(pane) : null; sess.textContent = sid ? ("🔗" + sid.toUpperCase()) : (pane ? "未关联" : ""); sess.classList.toggle("unbound", !!pane && !sid); }
  const proj = $(".pane-proj", sec); if (proj) proj.textContent = state.projects.get(state.activeProject)?.name || "";
  const st = $(".pane-status", sec); if (st) { const dot = st.querySelector(".dot"); const txt = st.querySelector("span:last-child"); if (pane) { dot.className = running(pane) ? "dot on" : "dot idle"; txt.textContent = running(pane) ? "就绪" : "…"; } else { dot.className = "dot idle"; txt.textContent = "空闲"; } }
  const ta = $("textarea", sec); if (ta) ta.disabled = !pane;
  const sb = $$("button", sec).find((b) => b.textContent === "发送"); if (sb) sb.disabled = !pane;
}
const running = (p) => { const all = [...state.projects.values()].flatMap((pr) => pr.panes); const pn = all.find((x) => x.pane === p); return pn ? pn.running !== false : false; };

function setBusy(sec, busy, label) { const st = $(".pane-status", sec); if (!st) return; const dot = st.querySelector(".dot"); const txt = st.querySelector("span:last-child"); dot.className = busy ? "dot busy" : sec.dataset.pane ? "dot on" : "dot idle"; if (label) txt.textContent = label; }
function clearLog(sec) { const l = $(".log", sec); if (l) l.innerHTML = ""; }
function pushUser(sec, text) { addMsg(sec, "user", text, { who: `你 · 窗格${(sec.dataset.pane || "").toUpperCase()}` }); }
function addMsg(sec, role, text, opts = {}) { const l = $(".log", sec); if (!l) return null; const m = el("div", "msg " + role); if (opts.who) m.appendChild(el("div", "who", opts.who)); const bd = el("div", ""); bd.textContent = text; m.appendChild(bd); if (role === "assistant") attachRefToolbar(sec, m); l.appendChild(m); l.scrollTop = l.scrollHeight; return m; }
function attachRefToolbar(sec, node) { if (node.querySelector(".toolbar")) return; const pane = sec.dataset.pane; if (!pane) return; const tb = el("div", "toolbar"); const b = el("button", "", "📋 加入参考"); b.onclick = () => { send({ kind: "ref:create", pane, rawText: node.textContent.trim(), label: "" }); b.textContent = "✔ 已入库"; b.disabled = true; }; tb.appendChild(b); node.appendChild(tb); }

function highlightActiveLeaf() { $$("section.pane").forEach((s) => s.classList.toggle("active", s.dataset.pane === state.activePane && !!s.dataset.pane)); }

function afterSplit(leaf, dir) { const fresh = splitLeaf(leaf, dir); persistLayouts(); renderCenter(); pickFor(fresh); }
function showSplitMenu() {
  const pop = el("div", "pop");
  const mk = (label, dir) => {
    const b = el("button", "", label);
    b.onclick = () => {
      pop.remove();
      // ensure there is a leaf to split; do NOT pre-create a pane here (pickFor handles it)
      let lay = curLayout();
      if (!lay || !allLeaves().length) { lay = mkLeaf(null); setLayout(lay); }
      const leaves = allLeaves();
      const leaf = leaves.find((l) => l.pane === state.activePane) || leaves.find((l) => l.pane) || leaves[0];
      state.activeLeaf = leaf;
      afterSplit(leaf, dir);
    };
    pop.appendChild(b);
  };
  mk("⇄ 左右分", "col");
  mk("⇅ 上下分", "row");
  const can = el("button", "", "取消"); can.onclick = () => pop.remove(); pop.appendChild(can);
  document.body.appendChild(pop);
}
function pickFor(leaf) {
  const proj = state.projects.get(state.activeProject);
  // list sessions NOT bound to any pane (1:1)
  const freeSessions = proj ? (proj.sessions || []).filter((s) => s.openPane == null) : [];
  const pop = el("div", "pop");
  if (freeSessions.length) {
    const sel = document.createElement("select");
    freeSessions.forEach((s) => { const o = el("option", "", `会话 ${s.id.toUpperCase()}`); o.value = s.id; sel.appendChild(o); });
    sel.value = freeSessions[0].id;
    const go = el("button", "", "关联此会话");
    go.onclick = async () => {
      pop.remove();
      // ensure the leaf has a real pane key first (empty pane → register via pane:new)
      let paneKey = leaf.pane;
      if (!paneKey) {
        const pr = await rpc("pane:new", { projectId: state.activeProject });
        if (!pr || !pr.pane) { toast("创建窗格失败", true); return; }
        paneKey = pr.pane;
        leaf.pane = paneKey;
        persistLayouts();
      }
      const r = await rpc("pane:bind", { pane: paneKey, sessionId: sel.value });
      if (r && r.sessionId) { await refreshCatalog(); render(); loadFileTree(); }
    };
    const can = el("button", "", "取消"); can.onclick = () => pop.remove();
    pop.append("选择要关联的会话：", sel, go, can);
  } else {
    const go = el("button", "", "＋ 新建会话"); go.onclick = async () => { pop.remove(); await newSessionOnly(); };
    const can = el("button", "", "取消"); can.onclick = () => pop.remove();
    pop.append("当前项目没有空闲会话，新建一个？", go, can);
  }
  document.body.appendChild(pop);
}

/* ==================== PANE EVENTS (activity + leaf routing) ==================== */
function consumePaneEvent(p) {
  const sid = sessionOfPane(p.pane) || p.pane; // track status per session
  const a = actInit(sid); const d = p.payload || {}; const type = p.type;
  if (type === "agent_start") { a.status = "working"; a.tool = ""; }
  else if (type === "tool_execution_start") { a.status = "working"; a.tool = (d.toolName || "").toString(); }
  else if (type === "tool_execution_end") { a.tool = ""; }
  else if (type === "message_update") { const ev = d.assistantMessageEvent || {}; if (ev.type === "text_delta") { if (a._reset !== true) { a.preview = ""; a._reset = true; } a.preview = (a.preview + ev.delta).slice(-200); } }
  else if (type === "message_start" && d.message?.role === "assistant") { a._reset = false; a.preview = ""; }
  else if (type === "message_end" && d.message?.role === "assistant") { a.preview = (extractText(d.message) || a.preview).slice(-200); a._reset = false; }
  if (type === "extension_ui_request") { a.status = "needs"; a.needsEol = (d.method || "").toString(); }
  else if (type === "agent_end") { a.status = "done"; a.tool = ""; a.needsEol = ""; }
  else if (type === "agent_settled") { if (a.status === "working") a.status = "done"; }
  a.t = Date.now();
  routeToLeaf(p);
  scheduleRefresh();
}
let cardTimer = 0;
function scheduleRefresh() { if (cardTimer) return; cardTimer = setTimeout(() => { cardTimer = 0; renderProjectTree(); renderTabbar(); persistActivity(); }, 60); }

function routeToLeaf(p) {
  const sec = $$("section.pane").find((s) => s.dataset.pane === p.pane);
  if (!sec) return;
  const d = p.payload || {};
  switch (p.type) {
    case "agent_start": setBusy(sec, true, "working…"); break;
    case "message_update": { const ev = d.assistantMessageEvent || {}; if (ev.type === "text_delta") appendDelta(sec, ev.delta); break; }
    case "message_start": if (d.message?.role === "assistant") openTok(sec); break;
    case "message_end": finalizeTok(sec, d.message); break;
    case "tool_execution_start": { const t = $(".pane-status span:last-child", sec); if (t) t.textContent = `工具: ${(d.toolName || "").toUpperCase()}`; break; }
    case "agent_end": case "agent_settled": endStream(sec); setBusy(sec, false, "idle"); break;
    default: break;
  }
}

const _tok = new WeakMap();
function tokOf(sec) { let t = _tok.get(sec); if (!t) { t = { open: false, text: "", node: null }; _tok.set(sec, t); } return t; }
function openTok(sec) { const t = tokOf(sec); const n = el("div", "msg assistant"); const l = $(".log", sec); l.appendChild(n); l.scrollTop = l.scrollHeight; t.open = true; t.text = ""; t.node = n; return t; }
function appendDelta(sec, more) { const t = tokOf(sec); if (!t.open) openTok(sec); t.text += more; if (t.node) t.node.textContent = t.text; const l = $(".log", sec); if (l) l.scrollTop = l.scrollHeight; }
function endStream(sec) { const t = tokOf(sec); t.open = false; }
function finalizeTok(sec, msg) { const t = tokOf(sec); if (t.open) { t.open = false; const txt = extractText(msg); if (txt) { t.text = txt; if (t.node) t.node.textContent = txt; attachRefToolbar(sec, t.node); } } }
function extractText(msg) {
  if (!msg || msg.content == null) return "";
  if (typeof msg.content === "string") return msg.content;
  const c = Array.isArray(msg.content) ? msg.content : [msg.content];
  return c.filter((x) => x && typeof x === "object" && x.type === "text").map((x) => x.text).join("");
}

/* ==================== FILE TREE + PREVIEW ==================== */
async function loadFileTree() {
  const pane = state.activePane;
  if (!pane) { renderFileTree([]); return; }
  const pathArg = state.fs.pane === pane ? state.fs.path : "";
  const resp = await rpc("fs:list", { pane, path: pathArg });
  if (!resp) return;
  state.fs.pane = pane; state.fs.path = resp.path ?? ""; state.fs.entries = resp.entries || [];
  renderFileTree(state.fs.entries);
}
function renderFileTree(entries) {
  const host = $("#file-tree"); if (!host) return;
  host.innerHTML = "";
  const crumb = $("#file-crumb");
  if (crumb) { const proj = state.projects.get(state.activeProject); crumb.textContent = `${proj?.name || state.activePane || ""}${state.fs.path ? "/" + state.fs.path : ""}`; }
  if (!state.activePane) { host.appendChild(el("div", "ft-empty", "选中一个窗格后显示其项目文件")); return; }
  if (state.fs.path) { const up = el("div", "ft-row"); up.append(el("span", "ft-ico", "⬆"), el("span", "ft-name", "..")); up.onclick = () => { state.fs.path = state.fs.path.split("/").slice(0, -1).join("/"); loadFileTree(); }; host.appendChild(up); }
  if (!entries.length && !state.fs.path) { host.appendChild(el("div", "ft-empty", "（空目录）")); }
  for (const en of entries) {
    const row = el("div", "ft-row");
    row.append(el("span", "ft-ico", en.type === "dir" ? "📁" : iconFor(en.name)), el("span", "ft-name", en.name));
    if (en.type === "file") row.appendChild(el("span", "ft-size", fmtSize(en.size)));
    row.onclick = () => { if (en.type === "dir") { state.fs.path = state.fs.path ? state.fs.path + "/" + en.name : en.name; loadFileTree(); } else openPreview(en.name); };
    host.appendChild(row);
  }
}
function iconFor(name) { const e = name.split(".").pop().toLowerCase(); return ({ js: "🟨", ts: "🟦", json: "🧾", md: "📝", html: "🌐", css: "🎨", txt: "📄" })[e] || "📄"; }
const fmtSize = (n) => n < 1024 ? n + "B" : n < 1048576 ? (n / 1024).toFixed(1) + "K" : (n / 1048576).toFixed(1) + "M";

/* ---- lightweight syntax highlighting (json / py / md / js / ts / html / css) ---- */
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function highlightCode(text, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "json") return highlightJson(text);
  if (ext === "py") return highlightPy(text);
  if (ext === "md" || ext === "markdown") return highlightMd(text);
  if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx") return highlightJs(text);
  if (ext === "html") return highlightHtml(text);
  if (ext === "css") return highlightCss(text);
  return escapeHtml(text);
}
function highlightJson(t) {
  let s = escapeHtml(t);
  // string keys vs string values
  s = s.replace(/(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)(\s*:)/g, (m, q1, k, q2, colon) => `<span class="tk-key">${q1}${k}${q2}</span>${colon}`);
  s = s.replace(/(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)/g, `<span class="tk-str">$1$2$3</span>`);
  s = s.replace(/\b(true|false|null)\b/g, `<span class="tk-bool">$1</span>`);
  s = s.replace(/(-?\d+\.?\d*)/g, `<span class="tk-num">$1</span>`);
  return s;
}
function highlightPy(t) {
  let s = escapeHtml(t);
  s = s.replace(/(#[^\n]*)/g, `<span class="tk-com">$1</span>`);
  s = s.replace(/\b(def|class|return|import|from|if|elif|else|for|while|try|except|finally|with|as|in|not|and|or|None|True|False|lambda|pass|break|continue|yield|print|async|await|global|nonlocal|raise|del|is)\b/g, `<span class="tk-kw">$1</span>`);
  s = s.replace(/(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)/g, `<span class="tk-str">$1$2$3</span>`);
  s = s.replace(/(&#39;)((?:[^&]|&(?!#39;))*?)(&#39;)/g, `<span class="tk-str">$1$2$3</span>`);
  s = s.replace(/\b(\d+\.?\d*)\b/g, `<span class="tk-num">$1</span>`);
  return s;
}
function highlightMd(t) {
  let s = escapeHtml(t);
  s = s.replace(/^(#{1,6}\s+.*)$/gm, `<span class="tk-md-h">$1</span>`);
  s = s.replace(/^(\s*[-*+]\s+.*)$/gm, `<span class="tk-md-li">$1</span>`);
  s = s.replace(/(`[^`\n]+`)/g, `<span class="tk-code">$1</span>`);
  s = s.replace(/(\*\*[^*]+\*\*)/g, `<span class="tk-md-b">$1</span>`);
  s = s.replace(/(\[[^\]]+\]\([^)]+\))/g, `<span class="tk-md-link">$1</span>`);
  return s;
}
function highlightJs(t) {
  let s = escapeHtml(t);
  s = s.replace(/(\/\/[^\n]*)/g, `<span class="tk-com">$1</span>`);
  s = s.replace(/\b(const|let|var|function|return|import|export|from|if|else|for|while|try|catch|finally|class|extends|new|this|async|await|typeof|instanceof|null|undefined|true|false|throw|switch|case|break|continue|default|in|of|do)\b/g, `<span class="tk-kw">$1</span>`);
  s = s.replace(/(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)/g, `<span class="tk-str">$1$2$3</span>`);
  s = s.replace(/(&#39;)((?:[^&]|&(?!#39;))*?)(&#39;)/g, `<span class="tk-str">$1$2$3</span>`);
  s = s.replace(/\b(\d+\.?\d*)\b/g, `<span class="tk-num">$1</span>`);
  return s;
}
function highlightHtml(t) {
  let s = escapeHtml(t);
  s = s.replace(/(&lt;\/?[a-zA-Z][^&]*?&gt;)/g, `<span class="tk-tag">$1</span>`);
  s = s.replace(/([a-zA-Z-]+)(=)(&quot;[^&]*?&quot;)/g, `<span class="tk-attr">$1</span>$2<span class="tk-str">$3</span>`);
  return s;
}
function highlightCss(t) {
  let s = escapeHtml(t);
  s = s.replace(/(\/[^\n]*)/g, `<span class="tk-com">$1</span>`);
  s = s.replace(/([.#]?[a-zA-Z-]+)(\s*:)/g, `<span class="tk-prop">$1</span>$2`);
  s = s.replace(/(&quot;[^&]*?&quot;)/g, `<span class="tk-str">$1</span>`);
  s = s.replace(/\b(\d+\.?\d*(?:px|em|rem|%|vh|vw)?)\b/g, `<span class="tk-num">$1</span>`);
  return s;
}

async function openPreview(name) {
  const pane = state.activePane;
  const rel = state.fs.path ? state.fs.path + "/" + name : name;
  const resp = await rpc("fs:read", { pane, path: rel });
  const body = $("#preview-body"); const pathEl = $("#preview-path");
  if (!body) return;
  body.innerHTML = ""; if (pathEl) pathEl.textContent = rel;
  // auto-expand on file select
  if (!state.previewOpen) { state.previewOpen = true; applyLayout(); }
  if (!resp) return;
  if (resp.ftype === "image") {
    const img = el("img"); img.src = `data:${resp.mime};base64,${resp.data64}`; body.appendChild(img);
  } else if (isMarkdown(name)) {
    const doc = el("div", "md-doc", "");
    doc.innerHTML = renderMarkdown(resp.text || "(空文档)");
    if (resp.truncated) doc.appendChild(el("div", "code-trunc", `…（已截断，${fmtSize(resp.size)}）`));
    body.appendChild(doc);
  } else {
    const text = resp.text || "(空文件)";
    const highlighted = highlightCode(text, name);
    const pre = el("pre", "code-pre", "");
    pre.innerHTML = highlighted;
    if (resp.truncated) pre.appendChild(el("div", "code-trunc", `\n…（已截断，${fmtSize(resp.size)}）`));
    body.appendChild(pre);
  }
}
const isMarkdown = (name) => /\.[mM][dD]$/.test(name) || /\.markdown$/i.test(name);

/* render markdown source into formatted HTML (no external deps) */
function renderMarkdown(src) {
  const lines = src.split(/\r?\n/);
  let html = "";
  let inCode = false, codeBuf = [];
  let listTag = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { html += "<p>" + inlineMd(para.join("\n")) + "</p>"; para = []; } };
  const flushList = () => { if (listTag) { html += `</${listTag}>`; listTag = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inCode) { flushPara(); flushList(); inCode = true; codeBuf = []; }
      else { html += `<pre class="md-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`; inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { flushPara(); flushList(); html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    if (ul) { flushPara(); if (listTag !== "ul") { flushList(); html += "<ul>"; listTag = "ul"; } html += `<li>${inlineMd(ul[1])}</li>`; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ol) { flushPara(); if (listTag !== "ol") { flushList(); html += "<ol>"; listTag = "ol"; } html += `<li>${inlineMd(ol[1])}</li>`; continue; }
    if (/^\s*>\s?/.test(line)) { flushPara(); flushList(); html += `<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ""))}</blockquote>`; continue; }
    if (/^\s*[-*_]\s*[-*_]\s*[-*_][-*_\s]*$/.test(line)) { flushPara(); flushList(); html += "<hr>"; continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return html;
}
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, `<img class="md-img" src="$2" alt="$1">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>`);
  s = s.replace(/`([^`]+)`/g, `<code class="md-ic">$1</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, `<strong>$1</strong>`);
  s = s.replace(/(^|\s)\*([^*\s]+)\*/g, `$1<em>$2</em>`);
  return s;
}

/* ---- preview width drag ---- */
function initPreviewDrag() {
  const bar = $("#split-preview"); if (!bar) return;
  let d = null;
  bar.addEventListener("pointerdown", (e) => { d = { x0: e.clientX, w0: state.previewW }; document.body.classList.add("dragging"); window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up, { once: true }); e.preventDefault(); });
  const mv = (e) => { if (!d) return; const max = Math.max(240, window.innerWidth - 620); state.previewW = Math.max(240, Math.min(max, d.w0 - (e.clientX - d.x0))); applyLayout(); };
  const up = () => { d = null; document.body.classList.remove("dragging"); window.removeEventListener("pointermove", mv); };
}
function panelIcon({ leftOn, rightOn }) {
  // A two-pane rectangle (like VSCode's side-bar toggle): left narrow bar + right block.
  // The side that is collapsed simply isn't drawn.
  const x0 = 3, y0 = 3, w = 18, h = 18;
  let s = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  if (leftOn) s += `<rect x="${x0 + 2}" y="${y0 + 2}" width="5.5" height="${h - 4}" rx="1" fill="currentColor" opacity="0.9"/>`;
  if (rightOn) s += `<rect x="${x0 + 10}" y="${y0 + 2}" width="${w - 12}" height="${h - 4}" rx="1" fill="currentColor" opacity="0.9"/>`;
  if (leftOn && rightOn) s += `<line x1="${x0 + 9}" y1="${y0}" x2="${x0 + 9}" y2="${y0 + h}" stroke="currentColor" stroke-width="1.1"/>`;
  return `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">${s}</svg>`;
}
function applyLayout() {
  const grid = $("#layout3");
  if (!grid) return;
  const leftW = state.leftOpen ? "var(--rail-w)" : "34px";
  const splitW = state.previewOpen ? "6px" : "0px";
  const previewW = state.previewOpen ? `${state.previewW}px` : "34px";
  grid.style.gridTemplateColumns = `${leftW} 1fr ${splitW} ${previewW}`;
  const leftRail = $("#left-rail");
  if (leftRail) leftRail.classList.toggle("collapsed", !state.leftOpen);
  const prevRail = $("#preview-rail");
  if (prevRail) prevRail.classList.toggle("collapsed", !state.previewOpen);
  const lbtn = $("#left-toggle");
  if (lbtn) { lbtn.innerHTML = panelIcon({ leftOn: state.leftOpen, rightOn: true }); lbtn.title = state.leftOpen ? "收缩左侧" : "展开左侧"; }
  const pbtn = $("#preview-toggle");
  if (pbtn) { pbtn.innerHTML = panelIcon({ leftOn: true, rightOn: state.previewOpen }); pbtn.title = state.previewOpen ? "收缩预览" : "展开预览"; }
}
function toggleLeft() { state.leftOpen = !state.leftOpen; applyLayout(); }
function togglePreview() { state.previewOpen = !state.previewOpen; applyLayout(); }

/* ==================== REFERENCE LIB UI ==================== */
const libToggle = $("#lib-toggle");
if (libToggle) libToggle.onclick = () => { const p = $("#lib-panel"); p.hidden = !p.hidden; if (!p.hidden) send({ kind: "ref:list" }); };
function renderRefs(refs) {
  const ul = $("#ref-list"); if (!ul) return;
  ul.innerHTML = "";
  if (!refs?.length) { ul.appendChild(el("li", "", "（暂无跨窗格引用）")); return; }
  const all = [...state.projects.values()].flatMap((pr) => pr.panes.map((p) => p.pane));
  for (const r of refs) {
    const li = el("li", "");
    li.append(el("code", "", `窗格 ${r.pane.toUpperCase()}`), document.createTextNode(` · ${r.label || "未命名"} · ${new Date(r.ts).toISOString().slice(11, 19)}`));
    const sel = document.createElement("select"); sel.style.marginLeft = "8px";
    for (const p of all) { const o = el("option", "", `窗格 ${p.toUpperCase()}`); o.value = p; sel.appendChild(o); }
    const go = el("button", "", "↪ 复制引用"); go.onclick = () => copyRefTo(r, sel.value);
    li.appendChild(sel); li.appendChild(go);
    ul.appendChild(li);
  }
}
function copyRefTo(r, targetPane) {
  const sec = $$("section.pane").find((s) => s.dataset.pane === targetPane);
  const ta = sec ? $("textarea", sec) : null;
  if (!ta) { toast("目标窗格不在当前布局中", true); return; }
  ta.value = (ta.value ? ta.value + "\n\n" : "") + `[跨窗格引用 ─ 窗格:${r.pane} · ${r.id}]\n\n${r.rawText}`;
  ta.focus(); toast(`已复制引用到 窗格${targetPane.toUpperCase()}`, false);
}
function toast(msg, isErr) { let t = $("#toast"); if (!t) { t = el("div", "toast"); t.id = "toast"; document.body.appendChild(t); } t.textContent = msg; t.classList.toggle("serr", !!isErr); t.classList.add("show"); clearTimeout(t._to); t._to = setTimeout(() => t.classList.remove("show"), 2600); }

function repaintCounts() {
  const c = $("#left-count"); if (c) { let n = 0; for (const pr of state.projects.values()) n += (pr.sessions || []).length; c.textContent = `${state.projects.size}项目/${n}会话`; }
}

/* ==================== BOOT ==================== */
loadActivity();
$("#new-project") && ($("#new-project").onclick = newProject);
$("#card-mode-toggle") && ($("#card-mode-toggle").onclick = () => { state.projectMode = state.projectMode === "cards" ? "list" : "cards"; renderProjectTree(); });
$("#view-control") && ($("#view-control").onclick = () => setView("control"));
$("#view-workbench") && ($("#view-workbench").onclick = () => setView("workbench"));
// control-dock: multi-level background menu + grid cols
$("#bg-menu-btn") && ($("#bg-menu-btn").onclick = (e) => {
  e.stopPropagation();
  const m = $("#bg-menu");
  if (m) m.hidden = !m.hidden;
});
// close menu when clicking elsewhere
document.addEventListener("click", (e) => {
  const m = $("#bg-menu");
  if (m && !m.hidden && !e.target.closest(".bg-menu-wrap")) m.hidden = true;
});
// menu items
const bgItem = (act, fn) => { const b = $(`.bg-item[data-act="${act}"]`); if (b) b.onclick = (e) => { e.stopPropagation(); fn(); }; };
bgItem("default", () => { state.bg = { type: "default" }; persistBg(); applyBackground(); $("#bg-menu").hidden = true; });
bgItem("custom", () => { const s = $("#bg-custom-sub"); if (s) { s.hidden = !s.hidden; if (!s.hidden) loadBgHistory(); } });
// history collapsible labels
$$(".bg-hist-label").forEach((lbl) => {
  lbl.onclick = (e) => {
    e.stopPropagation();
    const target = $(`#${lbl.dataset.target}`);
    if (target) { target.hidden = !target.hidden; lbl.classList.toggle("open", !target.hidden); }
  };
});
bgItem("image", () => { $("#bg-menu").hidden = true; $("#bg-file-image").click(); });
bgItem("video", () => { $("#bg-menu").hidden = true; $("#bg-file-video").click(); });
$("#bg-file-image") && ($("#bg-file-image").addEventListener("change", (e) => {
  const file = e.target.files?.[0]; if (file) uploadBgFile(file, "image");
  e.target.value = "";
}));
$("#bg-file-video") && ($("#bg-file-video").addEventListener("change", (e) => {
  const file = e.target.files?.[0]; if (file) uploadBgFile(file, "video");
  e.target.value = "";
}));
$("#grid-cols") && ($("#grid-cols").addEventListener("input", (e) => { state.gridCols = parseInt(e.target.value, 10); persistCols(); applyGridCols(); }));
$("#preview-toggle") && ($("#preview-toggle").onclick = togglePreview);
$("#left-toggle") && ($("#left-toggle").onclick = toggleLeft);
initPreviewDrag();
applyLayout();
applyBackground();
applyGridCols();
setView("control");
connect();
