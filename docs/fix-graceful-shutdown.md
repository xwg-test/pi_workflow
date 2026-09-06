# Fix 文档：Workflow 优雅关闭 + 插件路径探测

- **日期**：2026-09-06
- **影响文件**：`packages/orchestrator/src/index.js`、`scripts/workflow.ts`、`README.md`
- **性质**：Bug 修复（跨平台：Windows / macOS / Linux）

---

## 背景

Workflow 是「浏览器 UI + 常驻 Node orchestrator + 每窗格一个 `pi --mode rpc` 子进程」的三层架构。用户通过 pi 内的 `/workflow` 插件命令启动 / 停止服务。

排查中发现两个问题：

1. `/workflow stop` 关闭服务时会残留孤儿的 `pi --mode rpc` 子进程。
2. `/workflow` 在项目目录内启动 pi 时，探测不到 Workflow 项目路径。

---

## 问题 1：停止服务会残留孤儿 `pi --mode rpc` 进程

### 现象

用 `/workflow stop` 停止服务后，orchestrator 进程被终止，但已打开窗格对应的
`pi --mode rpc` 子进程仍然存活，成为孤儿进程继续占用内存。

### 根因

| 平台 | 旧版停止方式 | 为什么残留 |
|---|---|---|
| Windows | `taskkill /F /PID <pid>` | 强制杀，不触发 orchestrator 的优雅退出逻辑，子进程不被连带清理 |
| macOS / Linux | `kill <pid>`（默认 SIGTERM） | 旧版 orchestrator **只注册了 SIGINT、未注册 SIGTERM**，收到 SIGTERM 立即退出；Unix 下父进程退出时子进程不会被终止，而是被 re-parent 到 init/launchd |

> **macOS 检查结论**：✅ 存在同类问题。与 Windows 触发路径不同（SIGTERM 未处理 vs. taskkill /F 强杀），
> 但后果一致——`pi --mode rpc` 子进程在服务停止后残留为孤儿进程。
> （本结论为代码审查得出；Windows 已完成运行时实测，macOS/Linux 未在实体机器上跑测。）

### 修复

1. **orchestrator**（`packages/orchestrator/src/index.js`）
   - 抽出 `shutdown()`：先停掉所有窗格的 `pi --mode rpc` 子进程，再 `process.exit(0)`。
   - 新增 `GET/POST /shutdown` HTTP 接口，响应后延迟 50ms 调用 `shutdown()`，确保响应先刷出。
   - 同时注册 `SIGINT` 与 `SIGTERM` → `shutdown`（补上了 Unix 系缺失的 SIGTERM 处理）。

2. **插件**（`scripts/workflow.ts`）
   - `stopServer()` 改为三步走：
     1. 先 `POST /shutdown` 请求优雅停止；
     2. 轮询最多 3 秒等待端口释放；
     3. 失败 / 超时才 `taskkill /F`（Windows）/ `kill`（Unix）兜底。

---

## 问题 2：`/workflow` 探测不到项目目录

### 现象

在项目目录内启动 pi 后输入 `/workflow`，提示「未找到 Workflow 项目」。

### 根因

插件的 `resolveWorkflowDir()` 只扫描 `~/workflow`、`~/projects/workflow` 等固定常见位置，
且未设置 `WORKFLOW_DIR` 环境变量时，无法命中实际的项目路径（如 `E:/Project/Pi/helloPi/workflow`）。

### 修复

在候选列表首位加入 `process.cwd()`（pi 当前工作目录），在项目里启动 pi 即可直接命中。

---

## 验证结果

```
POST /shutdown → {"ok":true}
✅ 端口已释放（优雅关闭成功）
✅ 无残留 pi 子进程
```

`node --check` 语法校验通过（index.js / workflow.ts）。

---

## 使用方式

```bash
/workflow            # 启动并打开浏览器
/workflow start      # 仅启动服务
/workflow open       # 仅打开浏览器
/workflow status     # 查看状态
/workflow stop       # 停止服务（优雅关闭：先停所有窗格子进程，再退服务，不留孤儿进程）
```

> 关闭浏览器标签页**不会**停止服务，请用 `/workflow stop`（或在启动它的终端按 Ctrl+C）。
