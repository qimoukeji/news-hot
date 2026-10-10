# Claude 额度动态

只采集 [@ClaudeDevs](https://x.com/ClaudeDevs) 发布的 Claude 额度重置、重置卡与一次性奖励额度消息，提供中文原帖、公告与确认、北京时间、适用范围和历史日历。回复或引用里的其他作者仅作必要上下文，不能作为官方承诺。页面使用“Claude 额度动态”，现有 URL、模块与任务标识保持不变。

## 配置与初始化

```dotenv
CLAUDE_RESET_PROVIDER=socialdata
CLAUDE_RESET_SCAN_MINUTES=15
MONITOR_MODEL=default
# SOCIALDATA_API_KEY=<your-key>
# 也可使用 twitterapi_io，凭据与 Codex 共用 TWITTERAPI_IO_API_KEY。
```

默认 SocialData、每 15 分钟扫描，识别与 Codex 共用 `MONITOR_MODEL`；填 `default` 或未配置时使用 `LLM_*`，也可填具名模型预设。后台“重置监控识别”的选择对两个模块同时生效。每天北京时间 04:40 查漏最近 24 小时；任务名为 `claude-reset.tick` 和 `claude-reset.lookback`。修改后重启 API 和 worker。

开发保持 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false` 和推送安全阀关闭。采集凭据、预算、代理与 Codex 共用，执行锁、成功检查点、事件、回执用途和通知各自独立。初始化先确认真实有限范围，再执行：

```bash
npm run initialize -w @aihot/claude-reset -- --since 2026-10-08T00:00:00Z --until 2026-10-09T00:00:00Z
```

此命令会实际采集和识别，要求明确开启采集与模型安全阀、配置凭据与预算。起止时间必须带时区且 `since < until <= 当前时间`；失败保留帖子但不写成功检查点。Docker 命令、详细采集规则和人工复核见 [共享引擎说明](../reset-monitor/README.md)。

## 识别与时间

启用 `direct_reset`（额度重置）、`reset_credit`（重置卡）和 `bonus_credit`（奖励额度），忠实保留原帖中的产品、套餐及五小时／周额度范围。官方明确提供的一次性云会话赠额归入奖励额度，独立消费池不等于重置使用计数；重置卡必须明确可兑换重置次数。额度提升、API 赠金、每月 API credits、普通限额调整和日常自动重置规则不生成事件。

奖励额度分别展示适用套餐和产品、金额或用量原话、资格条件、领取方式、领取截止和奖励到期。未明确的字段不补齐。官方说明活动已可领取，表示符合条件的用户能够申领，不表示个人账户已经领取或到账。奖励统计、日历和通知独立，不计入重置次数；奖励活动不能用个人账户回执核对来确认。

提示词与 Claude 专属校验区分奖励消费池、可兑换重置次数及 API 赠金，原始模型结果和排除原因继续保留供审计。同帖同时宣布真实重置时逐命题处理，不整帖丢弃；人工复核可修正自动结论，但不得使用本模块未启用的事件类型。升级代码不会自动重识别、回填或改写历史记录。

只转换原帖明确给出的时间：带明确时区的钟点／区间，或明确小时数的相对时间，换算北京时间。没给时间、无时区钟点、“很快”等模糊表达保留原话并显示“时间未说明”；不套用 Codex／Tibo 的太平洋时间和发放惯例，不接受模型到账预测。领取截止与奖励到期独立换算，不能相互借用时区或推测年份，也不作为重置生效时间。预计时间经过不代表确认完成。

## 入口

| 入口 | 用途 |
| --- | --- |
| `/claude-reset` | 当前状态与历史日历 |
| `/claude-reset/history/YYYY-MM-DD` | 北京时间某天记录 |
| `/admin/claude-reset` | 管理与人工复核；原两类支持账户核验 |
| `/admin/claude-reset/posts/:id/review` | 完整帖子复核 |
| `/api/site/claude-reset` | 页面数据与对应版本、日期子接口 |
| `/api/v1/claude-resets` | 完整公开历史 |
| `/api/v1/claude-resets/recent` | 最近七天与待完成事件，支持 ETag |
| `/api/v1/agent/claude-resets` | Agent Markdown |
| MCP `get_claude_resets`（带站点前缀） | 同一事实的文本与结构化数据 |

全部读写由服务端定义限定 `monitor_id='claude'`，公开内容匿名，后台仅管理员可用。模块不新增独立表；安装和数据库升级见 [部署说明](../../docs/deploy.md#重置监控)。
