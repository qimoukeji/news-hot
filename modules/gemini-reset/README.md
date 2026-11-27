# Gemini 额度动态

跟踪 Varun Mohan 发布的 Gemini 和 Google Antigravity 用户额度重置、重置卡和一次性奖励额度。多模型共享一次重置时记录为同一事件，摘要保留原帖说明的适用范围。[X 上的 @_mohansolo](https://x.com/_mohansolo)

采集主帖与自回复，关闭回复他人和关键词初筛。默认使用 SocialData，每 15 分钟扫描，沿用共享 `MONITOR_MODEL`；可通过 `GEMINI_RESET_PROVIDER` 和 `GEMINI_RESET_SCAN_MINUTES` 调整。首次运行以观察起点开始增量采集。账号及采集选项见 [站点配置](../../site/reset-monitors.ts)，完整流程见 [共享采集流程](../../docs/reset-monitor-collection.md)。

| 入口 | 路径或工具 |
| --- | --- |
| 公开页面与历史 | `/gemini-reset`、`/gemini-reset/history/:date` |
| 管理后台 | `/admin/gemini-reset` |
| 总览与事件接口 | `/api/v2/overview`、`/api/v2/gemini-resets` |
| Agent 与 MCP | `/api/v2/agent/gemini-resets`、`get_gemini_resets` |
| Webhook 平台标识 | `gemini` |
