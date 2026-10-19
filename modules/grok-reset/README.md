# Grok 额度动态

采集配置账号的额度重置、重置卡和一次性奖励额度。初始名单保留 [@bot](https://x.com/bot) 与 [@grok](https://x.com/grok)，账号、默认产品、套餐集中在 `site/reset-monitors.ts`。配置账号均可独立提供事件依据，其他作者仅作上下文。使用 [共享重置监控引擎](../reset-monitor/README.md)，不新建数据表。

## 产品与时间

沿用适用产品和套餐字段。原帖未说明产品时，`@bot` 默认 Grok Bot，`@grok` 默认 Grok 普通额度；原文明确产品时以原文为准，套餐和额度周期不推测。不同产品及冲突套餐不自动合并，跨账号同一事件需要明确依据，歧义留人工复核。默认产品不覆盖已有事件或人工字段。

只记录真实的一次性动作，普通限额调整、日常自动重置规则、API 赠金、政策解释和玩笑不生成事件。奖励活动可领取不代表个人领取或到账；领取截止与奖励到期独立记录，不计入重置次数。

只有明确时区的时间或明确相对时长才换算北京时间，缺时间显示“时间未说明”，不采用到账预测。

## 配置与运行

账号在 `site/reset-monitors.ts`，初始账号为 `@bot`、`@grok`。使用 `GROK_RESET_PROVIDER`、`GROK_RESET_SCAN_MINUTES` 与共享 `MONITOR_MODEL`；默认 SocialData、每 15 分钟扫描，支持 TwitterAPI.io。配置修改后重启 API 与 worker。

三个平台统一只采非回复主帖，排除回复、自回复和纯转推，保留非回复引用帖；不加内容关键词。模型识别后关联事件并补齐 v2，没有父帖补采或历史初始化。新安装从首次运行时刻向前采集，已有截止继续完整增量窗口。历史事件及相关证据保留，无关旧采集记录按清单备份后清理。具体流程、失败语义及清理命令见 [共享引擎](../reset-monitor/README.md)。

采集、模型与推送的安全阀默认关闭；真实调用及公开部署按运营授权执行。

## 入口

| 用途 | 地址 |
| --- | --- |
| 当前状态／按日历史 | `/grok-reset`、`/grok-reset/history/:date` |
| 后台／帖子复核 | `/admin/grok-reset`、`/admin/grok-reset/posts/:id/review` |
| 页面／后台 API | `/api/site/grok-reset`、`/api/admin/grok-reset` |
| 完整／近期历史 | `/api/v1/grok-resets`、`/api/v1/grok-resets/recent` |
| Agent Markdown | `/api/v1/agent/grok-resets` |
| MCP | 带站点前缀的 `get_grok_resets` |

所有读写限定 `monitor_id='grok'`，公开出口只读，后台仅管理员可用。2026-10-10 检查时两个 X 页面均返回 403，原帖样本尚未核验；测试样本为模拟，尚未完成真实公告准确率验证。
