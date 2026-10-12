# Grok 额度动态

采集 [@bot](https://x.com/bot) 与 [@grok](https://x.com/grok) 的额度重置、重置卡和一次性奖励额度。两账号均可独立提供事件依据，其他作者仅作上下文。使用 [共享重置监控引擎](../reset-monitor/README.md)，不新建数据表。

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

提供商支持 SocialData 与 TwitterAPI.io，凭据和预算与其他监控共用，识别共用 `MONITOR_MODEL`。默认每 15 分钟扫描，按 `bot`、`grok` 顺序完整读取同一窗口，每天北京时间 04:40 查漏最近 24 小时；任一步失败不推进检查点，下一轮从原成功截止时间重新扫描并按帖子 ID 去重。任务为 `grok-reset.tick` 与 `grok-reset.lookback`。

开发与测试关闭外部采集、模型和推送。首次真实采集或切换提供商，使用者必须确认有限时间范围、凭据、预算并明确授权付费采集。可以先仅采集，不调用正式识别、补采上下文或推送；此时只开启 `COLLECT_ENABLED`，保持 `MODEL_CALLS_ENABLED=false`：

```bash
npm run initialize -w @aihot/grok-reset -- --since <带时区ISO时间> --until <带时区ISO时间> --collect-only
```

仅采集模式保存分页断点和帖子，不推进完整流程的成功检查点。后续可以使用 Codex 对已存数据离线识别；正式识别必须另行获得使用者授权。需要一次完成采集、上下文和正式识别时，明确开启采集和模型安全阀，再运行：

```bash
npm run initialize -w @aihot/grok-reset -- --since <带时区ISO时间> --until <带时区ISO时间>
```

命令不修改 `.env`，要求 `since < until <= 当前时间`。首次初始化按页保存断点，失败后以相同起止时间、账号顺序、查询和筛选版本重跑即可继续；更换同一供应商的账号或密钥仍使用原断点，跳过已保存页及已完成查询。上下文或识别失败时不重采已完成搜索页，全部成功才清理断点并推进成功检查点；普通扫描和查漏保持失败后重扫规则。Docker 使用 `docker compose run --rm worker npm run initialize -w @aihot/grok-reset -- --since <ISO> --until <ISO>`。

已确认的首次 90 天范围策略位于 `initial-filter.ts`：保留全部非回复帖和额度相关官方回复。本地接受规则不收窄，供应商粗筛允许更多上下文；旧 v3 查询原样保留以继续已付费分页，补采两条与旧查询互斥的回复查询，覆盖普通额度、奖励、中文关键词及 `usage cap` 等原查询漏项。新增补采仍使用原时间窗口，只有全部查询完成才覆盖完整。查询词和长度测试使用模拟样本，不代表已经核验真实供应商搜索的召回率。

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
