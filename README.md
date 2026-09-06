# 🖥️ Workflow

一个运行在 pi 生态之上的**浏览器多会话工作台**。参考 dsh-worktable 的交互模型，用
`pi --mode rpc` 驱动多个相互隔离的 agent 会话，在浏览器里以项目分组、分屏窗格的方式
并行工作。

## 核心概念

```
项目 Project          —— 一个真实的工作目录
  ├── 会话 Session    —— 项目下持久保存的对话（手动删除才消失）
  └── 窗格 Pane       —— 打开某个会话的临时视图（关闭不影响会话）
```

| 概念 | 说明 | 持久化 |
|---|---|---|
| **项目** | 一个真实目录，可建多个 | 内存 + 启动时恢复 |
| **会话** | 项目下的独立对话，`s1/s2/...` | ✅ 落盘 `.workflow/sessions/<项目>/<会话>/*.jsonl` |
| **窗格** | 会话的临时窗口，`p1/p2/...`，1:1 绑定会话 | ❌ 纯内存，重启即清空 |

- **关窗格 ≠ 删会话**：关闭窗格只释放视图，会话数据保留，可随时重新打开恢复历史。
- **删会话**：项目树会话条目上的 🗑（二次确认），删除后数据不可恢复。
- **删项目**：同步清理该项目全部会话文件与索引。

## 界面布局

```
┌─────────────┬──────────────────────────┬──────────────┐
│ 左侧：项目区  │ 中间：会话工作台            │ 右侧：文件预览 │
│  · 项目树    │  · 控制室首页（项目卡片墙）   │  · 展开/收起   │
│  · 会话列表  │  · 工作台（tabs + 分屏窗格） │  · json/py/md │
│  · 文件管理器 │                          │    等预览      │
└─────────────┴──────────────────────────┴──────────────┘
```

- **控制室首页**：中间默认显示项目卡片墙（毛玻璃 + 蓝图网格 + 状态霓虹），点卡片进入该项目工作台。
- **工作台**：顶部 tabs 是打开的窗格，下方是分屏区域（可左右/上下分裂、拖分隔条调比例）。
- **左侧文件管理器**：展示当前项目目录，点文件在右侧预览（json/py/md 语法高亮、md 渲染成文档、图片直显）。

## 用法

**推荐（跨平台）**：

```bash
cd workflow
npm start          # 启动 → http://127.0.0.1:3180
npm run dev        # 开发模式（源码变更自动重启）
```

首次启动会自动安装 orchestrator 依赖。也可用传统方式：

```bash
./scripts/run.sh
# 或
cd packages/orchestrator && npm install && node src/index.js
```

> 前置要求：Node.js ≥ 20，且已全局安装 `pi`（`npm install -g @earendil-works/pi-coding-agent`）。

## 接入 pi（薄入口插件）

Workflow 核心是独立服务，但可通过一个薄扩展接入 pi，在 pi 里敲 `/workflow` 一键启动/打开。

```bash
# 把插件放入 pi 扩展目录
cp scripts/workflow.ts ~/.pi/agent/extensions/workflow.ts
# 重启 pi（或 /reload）后，在 pi 里输入：
/workflow            # 启动并打开浏览器
/workflow start      # 仅启动服务
/workflow open       # 仅打开浏览器
/workflow status     # 查看状态
/workflow stop       # 停止服务（优雅关闭：先停所有窗格子进程，再退服务，不留孤儿进程）
```

> **注意**：关闭浏览器标签页**不会**停止服务。Workflow 服务是常驻 Node 进程，
> 各窗格的 `pi --mode rpc` 子进程也独立运行。要真正关闭请用 `/workflow stop`
> （或在启动它的终端按 Ctrl+C）。

> 插件路径探测：优先读环境变量 `WORKFLOW_DIR`，否则扫描 `~/workflow`、`~/projects/workflow` 等常见位置（含当前 pi 工作目录）。

环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3180` | 服务端口 |
| `PI_BIN` | 自动解析 | pi 可执行（跳过 .cmd shim 直接调 bundle cli） |
| `WT_ROOT` | 自动推导 | 项目根目录 |
| `WT_DEFAULT_PROJECT_DIR` | `workflow/..` | seed 项目的真实工作目录 |

## 功能清单

- **多会话并行**：每窗格一个独立 `pi --mode rpc` 进程，进程级隔离，互不影响。
- **项目分组**：项目 = 真实目录 + 若干会话；每个项目 ≤ 9 个会话/窗格。
- **会话持久化**：会话存 `.workflow/sessions/`，`--session <file>` 恢复历史，刷新/重启不丢。
- **分屏布局**：递归 tiling split，按项目各自持久化布局。
- **文件管理 + 预览**：安全列目录/读文件（目录穿越防护），json/py/md/js/ts/html/css 高亮。
- **跨窗格引用**：窗格消息「📋 加入参考」→ 引用库 → 复制到其他窗格（带来源标注）。
- **自定义背景**：控制室首页支持默认蓝图 / 图片 / 动态壁纸；图片保留最近 10 次、动态保留最近 5 次历史，可一键切换。
- **状态指示**：会话状态点（working 黄 / needs 红 / done 绿 / idle 灰），实时事件驱动。

## 架构

```
浏览器 UI ──WebSocket──►  orchestrator (Node 常驻服务)
                            │
                            ├─ spawn pi --mode rpc（窗格 p1 → 会话 s1）
                            ├─ spawn pi --mode rpc（窗格 p2 → 会话 s2）
                            └─ ...
```

- **后端**：`packages/orchestrator/` — HTTP（静态 UI + 上传 + 历史）+ WebSocket（命令/事件）+ pi rpc 客户端。
- **前端**：`packages/ui/public/` — 纯静态（index.html / app.js / style.css），无构建。
- **会话隔离**：会话存专属 `--session-dir`，不污染 `~/.pi/agent/sessions`。

## 数据与安全

- 只 bind `127.0.0.1`，无遥测。
- 数据都在本机 `workflow/.workflow/`：会话、壁纸、历史、引用库。
- 文件接口带路径穿越防护，仅能读当前项目目录。
- 删除项目/会话会同步清理磁盘，不残留。

## 已知限制

- 终端面板等 worktable 式“应用窗口”需后续另做（pi 无对等物，主要自研量之一）。
- 状态快照（活动、背景偏好、布局）存浏览器 localStorage，跨设备不同步。
