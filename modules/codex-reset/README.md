# Codex 重置监控

跟踪配置账号的 Codex 额度重置、重置卡和奖励额度，提供公告、北京时间窗口、确认依据、关联原帖和历史日历。初始名单保留 `@thsottiaux`（Tibo）；多账号、套餐和采集范围在 `site/reset-monitors.ts` 配置。采集、事件处理、复核和页面使用 [共享重置监控引擎](../reset-monitor/README.md)。

## 配置与初始化

```dotenv
CODEX_RESET_PROVIDER=socialdata
CODEX_RESET_SCAN_MINUTES=15
# SOCIALDATA_API_KEY=<your-key>
# 或 CODEX_RESET_PROVIDER=twitterapi_io，使用 TWITTERAPI_IO_API_KEY。
MONITOR_MODEL=default
```

识别与 Claude、Grok 共用 `MONITOR_MODEL`，填 `default` 或未配置时使用 `LLM_*`，也可填具名模型预设；后台“重置监控识别”的选择同时影响所有重置监控模块。任务名称与通知去重保留。开发保持采集、模型和推送安全阀关闭；提供商、凭据、预算、失败处理及后台操作见共享引擎说明。实际首次启用或切换提供商前必须确认有限范围：

```bash
npm run initialize -w @aihot/codex-reset -- --since 2026-10-08T00:00:00Z --until 2026-10-09T00:00:00Z
```

命令实际采集并识别，需明确打开采集与模型安全阀；参数为带时区 ISO 时间。首次初始化保存分页断点，失败后以相同范围及采集配置重跑可继续，更换同供应商账号不会重采已提交页；普通增量扫描和查漏不使用分页断点。默认每 15 分钟扫描，每天北京时间 04:40 查漏 24 小时。

## Codex 专属规则

只有配置账号可提供承诺，其他作者仅作上下文。跨账号关联必须有可核验的回复、引用或原帖链接，不能仅凭时间相近合并。日常自动重置、条件政策、API 赠金、玩笑和未明确承诺的惊喜不生成事件；混合消息逐命题处理。解释“已应用”只有在主帖及可核验原帖共同证明同一待完成事件时才能确认，不能新增轮次。奖励可领取与个人到账分开；奖励单独展示和统计，不计入重置次数，不能用个人账户回执确认活动。

Tibo 原话的 PST／PT 按太平洋当地时间读，保留夏令时转换。明确钟点保持单点，只有原话给出区间才显示区间。相对小时、日期和命名时段按原帖或可核验父帖计算。约数可显示前后半小时，截止时间不延长。

只有账号配置显式绑定 `timePolicy: 'tibo'` 时才使用 Codex 原有预测；其他账号默认只认明确时间，缺时间保留原话。新事件保存自己的时间策略，历史事件按原规则读取、不回填。日期公告参考 Tibo 太平洋时间 16:30–21:30 的惯例；无日期时参考下一个惯例时段，转换北京时间。模型预测窗口必须格式正确、晚于公告、跨度不超过 36 小时，且不越过原话时间限制；页面明确标注预测依据。预计窗口结束仍保持未确认，不替代到账证据。

## 入口

| 入口 | 用途 |
| --- | --- |
| `/codex-reset` | 当前状态与历史日历 |
| `/codex-reset/history/YYYY-MM-DD` | 北京时间某天记录 |
| `/admin/monitor` | 管理与人工账户核验 |
| `/admin/monitor/posts/:id/review` | 完整帖子复核 |
| `/api/site/codex-reset` | 页面数据与对应版本、日期子接口 |
| `/api/v1/codex-resets` | 完整公开历史 |
| `/api/v1/codex-resets/recent` | 最近七天与待完成事件，支持 ETag |
| `/api/v1/agent/codex-resets` | Agent Markdown |
| MCP `get_codex_resets`（带站点前缀） | 同一事实的文本与结构化数据 |

公开入口和后台入口保持原地址；所有出口与 Claude 使用共享表，但限定 `monitor_id='codex'`。历史迁移保留，升级使用新的共享迁移，按 [部署说明](../../docs/deploy.md#重置监控) 备份并暂停写入。
