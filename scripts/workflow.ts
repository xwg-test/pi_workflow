/**
 * Workflow — 薄入口插件
 *
 * 在 pi 里敲 `/workflow` 即可启动（或打开）Workflow 多会话工作台。
 *
 * 注意：这个插件只是"入口/快捷方式"，真正的多会话 Web 能力由独立的
 * Workflow 服务（Node + 浏览器 UI + 多个 `pi --mode rpc` 子进程）承载，
 * 因为 pi 的 extension 是单会话、禁止常驻后台服务的，塞不进来。
 *
 * 用法：
 *   /workflow          启动服务并打开浏览器（已运行则只打开）
 *   /workflow start    仅启动服务（不打开浏览器）
 *   /workflow open     仅打开浏览器（服务须已在运行）
 *   /workflow status   查看服务状态
 *   /workflow stop     停止服务
 *
 * 安装：把本文件放到 ~/.pi/agent/extensions/workflow.ts 后重启 pi
 * 路径探测：优先用环境变量 WORKFLOW_DIR，其次扫描常见位置。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn, exec } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 3180;

// /workflow 子命令补全（输入 /workflow 后按 Tab 展示）
const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "start", label: "start", description: "仅启动服务" },
  { value: "open", label: "open", description: "仅打开浏览器" },
  { value: "status", label: "status", description: "查看服务状态" },
  { value: "stop", label: "stop", description: "停止服务" },
];

/** 探测 workflow 项目目录（环境变量 → 常见位置扫描） */
function resolveWorkflowDir(): string | null {
  // 1. 显式环境变量优先
  if (process.env.WORKFLOW_DIR && existsSync(process.env.WORKFLOW_DIR)) {
    return process.env.WORKFLOW_DIR;
  }
  const home = os.homedir();
  const candidates = [
    process.cwd(), // 当前 pi 工作目录（在项目里启动 pi 时最直接命中）
    path.join(home, "workflow"),
    path.join(home, "Workflow"),
    path.join(home, "projects", "workflow"),
    path.join(home, "Projects", "workflow"),
    path.join(home, "dev", "workflow"),
    path.join(home, "code", "workflow"),
  ];
  for (const c of candidates) {
    // 必须是包含 packages/orchestrator/src/index.js 的目录
    if (existsSync(path.join(c, "packages", "orchestrator", "src", "index.js"))) {
      return c;
    }
  }
  return null;
}

/** 检测 3180 端口是否已监听 */
function isRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: "/", method: "GET", timeout: 1500 }, () => {
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** 启动服务（后台，不阻塞 pi） */
function startServer(dir: string) {
  const isWin = process.platform === "win32";
  // Windows 需要 shell 才能正确跑 npm；mac/linux 直接 npm
  const child = spawn("npm", ["start"], {
    cwd: dir,
    detached: true,
    shell: isWin,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

/** 打开浏览器（跨平台） */
function openBrowser() {
  const url = `http://${HOST}:${PORT}`;
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const cmd = isWin ? `start "" "${url}"` : isMac ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.error("打开浏览器失败:", err.message); });
}

/** 优雅停止：请求 orchestrator 的 /shutdown 接口（停掉所有窗格再退出） */
function gracefulShutdown(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: "/shutdown", method: "POST", timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** 轮询等待服务退出（最多 waitMs 毫秒），返回是否已停止 */
async function waitUntilStopped(waitMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (!(await isRunning())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 兜底：强制杀掉占用 3180 端口的进程（仅本机开发用） */
function forceKill(): Promise<void> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const find = isWin
      ? `netstat -ano | findstr :${PORT} | findstr LISTENING`
      : `lsof -ti :${PORT}`;
    exec(find, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(); return; }
      const pid = isWin
        ? stdout.trim().split(/\s+/).pop()
        : stdout.trim().split(/\s+/)[0];
      if (!pid) { resolve(); return; }
      exec(isWin ? `taskkill /F /PID ${pid}` : `kill ${pid}`, () => resolve());
    });
  });
}

/** 停止服务：先优雅停止（/shutdown），失败或超时再强杀兜底 */
async function stopServer(): Promise<void> {
  if (await gracefulShutdown()) {
    if (await waitUntilStopped(3000)) return;
  }
  await forceKill();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("workflow", {
    description: "启动/打开 Workflow 多会话工作台",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0];

      if (sub === "stop") {
        await stopServer();
        ctx.ui.notify("Workflow 已停止", "info");
        return;
      }

      const running = await isRunning();
      if (sub === "status") {
        ctx.ui.notify(
          running ? `Workflow 运行中 → http://${HOST}:${PORT}` : "Workflow 未运行",
          running ? "info" : "warning",
        );
        return;
      }

      const dir = resolveWorkflowDir();
      if (!dir) {
        ctx.ui.notify(
          "未找到 Workflow 项目。请设置环境变量 WORKFLOW_DIR 指向项目目录，\n" +
          "例如：export WORKFLOW_DIR=~/workflow",
          "error",
        );
        return;
      }

      if (!running) {
        const pid = startServer(dir);
        ctx.ui.notify(`Workflow 已启动（pid ${pid}）→ http://${HOST}:${PORT}`, "info");
      }

      // 默认与 open 子命令：打开浏览器（服务启动后稍等）
      if (sub !== "start") {
        setTimeout(openBrowser, running ? 0 : 1500);
      }
    },
  });
}
