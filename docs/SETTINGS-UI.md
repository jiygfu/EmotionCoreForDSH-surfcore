# SoulCore DSH 设置页

## 位置

DSH Web UI → Settings → **SoulCore**（order 8，在 SurfCore 与 Models 之间）。

## 页面内容

### 状态卡片

- 记忆工具是否已注册
- SQLite 是否存在
- SurfCore sidecar 是否存在，以及 enrichment / extension 数
- 最近记忆查询调用数

### 功能开关

- 记忆查询工具（`soulcore_memory`）
- 影子检索日志
- 影子检索写回标记

保存后，`soul-bridge` 在下一次调用时读取新值，不需要重装插件。

### 运行参数

- Python 路径
- SQLite 路径
- Node 路径
- 单次超时
- 影子最大并发

### 操作按钮

- 保存设置
- 导出增强 sidecar（`export-surfcore`）
- 运行一次本地评价（`appraise --limit 1`）
- 补齐感受附注（`felt-backfill --limit 5`）
- 修复旧身份（`repair-identities`）
- 刷新状态
- 测试记忆查询

这些操作都在本机 Python/SQLite 中执行，不经过 QQ API。

### 最近调用

读取：

```text
soulproject/data/memory-tool-calls.jsonl
```

显示时间、backend、模式和结果数。

## 持久化

```text
soulproject/data/soul-bridge-settings.json
```

默认：

```json
{
  "enabled": true,
  "shadowEnabled": true,
  "memoryTool": true,
  "mark": false,
  "timeoutMs": 4000,
  "maxInflight": 2,
  "pythonPath": "...",
  "nodePath": "node",
  "dbPath": "..."
}
```

## Host API

仅本机回环；写操作要求同源 + `application/json`。

```text
GET  /soulcore-settings/api/state
POST /soulcore-settings/api/action
```

`action`：

```text
save / test / export / appraise / repair / refresh
```

## 安装与验证

bundle：

```text
@soulproject/soulcore-settings
```

已安装并 applied。

已验证：

- `settings.section` occupant：`soulcore` active
- `GET /soulcore-settings/api/state` 返回 `ok=true`、`toolRegistered=true`
- `POST action=test` 可以执行本地查询
- `POST action=save memoryTool=false` 后，`soulcore_memory` 真的返回关闭提示
- 恢复 `memoryTool=true` 后工具恢复

## 注意

- 页面改的是本地设置文件，不改 `cordis.patch.yml`。
- SurfCore sidecar 合并仍需要 DSH 完整重启后才会进入宿主已加载的 `memory-card.js`。
- 当前浏览器页面若没有立即出现新标签，刷新 DSH Web UI 一次。
