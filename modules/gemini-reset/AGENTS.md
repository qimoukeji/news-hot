# Gemini 额度监控

账号和采集规则在 `site/reset-monitors.ts`，产品识别规则在 `prompt.ts`。模块入口及 `web/` 的路由适配器复用 `modules/reset-monitor/` 的共享实现，遵循该目录的规则。帖子、动作和事件使用共享表，以 `monitor_id=gemini` 隔离。
