# Grok 额度动态

采集配置账号的额度重置、重置卡和一次性奖励额度。初始名单保留 [@bot](https://x.com/bot) 与 [@grok](https://x.com/grok)，账号、默认产品、套餐和筛选集中在 `site/reset-monitors.ts`。配置账号均可独立提供事件依据，其他作者仅作上下文。使用 [共享重置监控引擎](../reset-monitor/README.md)，不新建数据表。

## 产品与时间

沿用适用产品和套餐字段。原帖未说明产品时，`@bot` 默认 Grok Bot，`@grok` 默认 Grok 普通额度；原文明确产品时以原文为准，套餐和额度周期不推测。不同产品及冲突套餐不自动合并，跨账号同一事件需要明确依据，歧义留人工复核。默认产品不覆盖已有事件或人工字段。

只记录真实的一次性动作，普通限额调整、日常自动重置规则、API 赠金、政策解释和玩笑不生成事件。奖励活动可领取不代表个人领取或到账；领取截止与奖励到期独立记录，不计入重置次数。

只有明确时区的时间或明确相对时长才换算北京时间，缺时间显示“时间未说明”，不采用到账预测。

## 配置与初始化

```dotenv
GROK_RESET_PROVIDER=socialdata
GROK_RESET_SCAN_MINUTES=15
MONITOR_MODEL=default
```

提供商支持 SocialData 与 TwitterAPI.io，凭据和预算与其他监控共用。本站与 Codex、Claude 统一在 `site/reset-monitors.ts` 使用 `processingMode: "collect_only"`，只采新主帖，保存原文并标记处理完成，不补历史、上下文或自动识别；没有识别结果的帖子在后台显示“仅采集”，不冒充无关结论。首次任务按使用者要求结案，未采范围不再续跑，原文、事件和原始判断保留。人工复核仍可使用，外部采集需另行授权。默认每 15 分钟按 `bot`、`grok` 顺序读取同一增量窗口，只有 `grok-reset.tick`，不注册每日查漏；任一作者失败保持原采集截止，下一轮按帖子 ID 去重。

开发与测试关闭外部采集、模型和推送。新安装或切换提供商的初始化须另行确认有限时间范围、凭据、预算并明确授权付费采集；只开启 `COLLECT_ENABLED`，保持 `MODEL_CALLS_ENABLED=false`：

```bash
npm run initialize -w @aihot/grok-reset -- --since <带时区ISO时间> --until <带时区ISO时间> --collect-only
```

持久 `collect_only` 策略保存原文和处理完成标记，`recognition` 保持空；即使省略命令的 `--collect-only` 也不会自动识别。所有主帖分页成功即推进采集截止并清理断点。命令不修改 `.env`，要求 `since < until <= 当前时间`；失败后以相同参数及配置重跑可继续，更换同一供应商账号或密钥不重复采已提交页。当前已结案任务从结案时刻继续增量，不重新启动初始化。Docker 使用 `docker compose run --rm worker npm run initialize -w @aihot/grok-reset -- --since <ISO> --until <ISO>`。

`initial-filter.ts` 保留首次 90 天所用筛选配置：全部非回复帖和额度相关官方回复；查询组与额外范围的定义供审计，已结案任务不再执行这些历史查询。常规增量可选筛选只在当前窗口查询，不补旧范围。未采满的 90 天不能宣称已完整覆盖，查询词和长度测试不代表真实供应商搜索召回率。

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
