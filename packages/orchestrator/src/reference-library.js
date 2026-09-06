/**
 * Cross-pane shared reference library (M0 seed).
 *
 * WHY: with per-pane isolated `--session-dir` (design choice #1), pane histories do NOT
 * naturally mix. When the user wants "pane 2 to reference pane 1's output/history", they
 * need an explicit mechanism. This module is that mechanism.
 *
 * Model (mirrors dsh-worktable's "self-explaining payload" idea):
 *  - A *reference* is a plain, provenance-stamped text block:
 *      [引用 pane:窗格1 · id:<entryId> · ts:<ts>] <原文>
 *  - A reference is *materialized* by a shared, read-only library dir (this is a "bridge"
 *    both panes' sessions can be pointed at) + injected as an ordinary user message when the
 *    user copies it into another pane's composer. No background cross-session streaming.
 *
 * M0 scope: create / list / get references persisted to a JSON "library", and render a
 * reference into the exact prose block that can be dropped into another pane's prompt.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export class ReferenceLibrary {
  /**
   * @param {string} libDir directory that holds the library index (should be shared/read-only
   *   across panes and NOT any pane's `--session-dir`).
   */
  constructor(libDir) {
    this.libDir = libDir;
    this.indexFile = join(libDir, "references.json");
  }

  async _ensure() {
    await mkdir(this.libDir, { recursive: true });
  }

  async _read() {
    try {
      const raw = await readFile(this.indexFile, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
  }

  async _write(list) {
    await this._ensure();
    await writeFile(this.indexFile, JSON.stringify(list, null, 2), "utf8");
  }

  nextId() {
    // monotonic-ish local id; not a collision-proof UUID but enough for a local workbench
    return `ref-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  /**
   * Create a reference entry from a raw text selection in some pane.
   * @param {{pane:string, entryId?:string, rawText:string, label?:string}} input
   */
  async create({ pane, entryId, rawText, label }) {
    const id = this.nextId();
    const ts = Date.now();
    const entry = {
      id,
      pane,
      entryId: entryId ?? null,
      label: label ?? "",
      ts,
      rawText,
    };
    const list = await this._read();
    list.push(entry);
    await this._write(list);
    return entry;
  }

  async list() {
    return this._read();
  }

  async get(id) {
    const list = await this._read();
    return list.find((e) => e.id === id) ?? null;
  }

  /**
   * Render a stored reference into the provenance-stamped prose block that is
   * actually what gets dropped into another pane's composer.
   */
  renderBlock(entry) {
    const paneLabel = entry.pane ? `窗格:${entry.pane}` : "窗格:?";
    const time = new Date(entry.ts).toISOString();
    const srcId = entry.entryId ? ` · id:${entry.entryId}` : "";
    const label = entry.label ? `${entry.label}` : "";
    return [
      `[跨窗格引用 ─ ${paneLabel}${srcId} · orig:${time} · ${entry.id}]`,
      label ? `(${label})` : null,
      "",
      entry.rawText,
      "",
      "── 摘录自上述来源，供当前窗格作参考。─",
    ]
      .filter((l) => l !== null)
      .join("\n");
  }
}
