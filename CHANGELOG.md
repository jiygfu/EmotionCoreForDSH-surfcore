# Changelog

## 0.3.0 — 2026-10-31

首个带版本号的公开快照。

### 记忆学补强

- SQLite FTS5 全文索引与中文 2-gram fallback；
- `source_kind`、`status`、`version`、`valid_from`、`valid_to`、`last_confirmed_at`；
- correction 的版本/取代链；
- 事件索引与原始记忆 ID 的追溯。

### 跨会话记忆

- `soulcore_memory` 默认查询本地全局库，私聊/群聊共用同一套长期记忆；
- `mode=surfcore` 仅作为显式兼容路径；
- L2 静态卡保留私聊/群聊各至少一张。

### 睡醒交接

- 新增 `sleep_runs` 睡眠账本；
- 新增确定性 `handoff`：上次停点、最近消息、pending、P 偏移、欲望原因、余额；
- bootstrap 改为「交接 → 现在 → 可核对 → 最后规则」；
- 移除开头的否定式身份宣告。

### 欲望

- `major` / `micro` 两层；
- micro 只覆盖 play/share/curious 等低风险念头；
- 不提高全局 affective/gain，不放大高危欲望。

### 设置页

- 可见名称统一为 EmotionCore；
- 记忆/FTS/L2/睡眠/交接/能力开关与重建按钮；
- `memory-stats`、`fts-rebuild` 本地命令。

## 0.2.0 之前

早期内部迭代，未单独打 tag；完整历史保留在本地，不随公开快照发布。
