# Fix 文档：`/workflow` 子命令自动补全

- **日期**：2026-09-06
- **影响文件**：`scripts/workflow.ts`
- **性质**：功能增强（命令参数补全）

---

## 背景

用户在 pi 输入框中录入 `/workflow s` 后没有弹出任何提示，期望在输入 `/workflow`
后能看到子命令（`start` / `open` / `status` / `stop`）的补全候选，不必每次手动敲完。

## 现象

- 输入 `/workflow ` 或 `/workflow s` 后，无任何补全提示弹出。

## 根因

pi 扩展命令的**参数补全**由 `registerCommand(name, options)` 里的
`options.getArgumentCompletions(argumentPrefix)` 提供。原插件只注册了 `description`
与 `handler`，未提供 `getArgumentCompletions`，因此 pi 内置补全器（`CombinedAutocompleteProvider`）
对 `/workflow <空格>` 之后的参数返回空，不展示候选。

> 触发机制：pi 的补全菜单由 `tab` 键触发（`tui.input.tab`）。补全器按空格切分命令名与
> 参数前缀，`argumentPrefix` 即 `/workflow ` 之后的文本，调用 `getArgumentCompletions` 得到候选。

## 修复

在 `scripts/workflow.ts` 中：

1. 引入类型 `AutocompleteItem`（来自 `@earendil-works/pi-tui`，仅类型导入，运行时被擦除）：

   ```ts
   import type { AutocompleteItem } from "@earendil-works/pi-tui";
   ```

2. 声明 4 个子命令候选：

   ```ts
   const SUBCOMMANDS: AutocompleteItem[] = [
     { value: "start",  label: "start",  description: "仅启动服务" },
     { value: "open",   label: "open",   description: "仅打开浏览器" },
     { value: "status", label: "status", description: "查看服务状态" },
     { value: "stop",   label: "stop",   description: "停止服务" },
   ];
   ```

3. 在 `registerCommand("workflow", …)` 中注册按前缀过滤的补全回调：

   ```ts
   getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
     const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
     return items.length > 0 ? items : null;
   },
   ```

## 效果

| 输入 | 补全候选 |
|---|---|
| `/workflow `（空格） | start / open / status / stop（全部） |
| `/workflow s` | start / status |
| `/workflow st` | start / status（继续按前缀收敛） |

## 使用方式

```
/reload                              # 重新加载插件
/workflow <空格> 后按 Tab            # 弹出子命令候选，选中回车即可
```

---

## 相关文档

- 上一轮修复：见 [fix-graceful-shutdown.md](./fix-graceful-shutdown.md)（优雅关闭 + 路径探测）。
