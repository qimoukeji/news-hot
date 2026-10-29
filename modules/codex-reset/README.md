# Codex 重置监控

跟踪配置账号的 Codex 额度重置、重置卡和奖励额度，以动作时间线展示事件当前状态、范围与原帖链接。初始账号为 [@thsottiaux](https://x.com/thsottiaux)（Tibo）；账号、套餐、产品和公开目录在 `site/reset-monitors.ts`。采集、复核和页面共用[重置监控引擎](../reset-monitor/README.md)。

## 运行与识别

使用 `CODEX_RESET_PROVIDER`、`CODEX_RESET_SCAN_MINUTES` 及共享 `MONITOR_MODEL`；默认 SocialData、每 15 分钟扫描，也支持 TwitterAPI.io。`site/reset-monitors.ts` 中的 collection 分别以 includeReplies 控制回复他人、includeSelfReplies 控制自回复、resetOnly 控制关键词加模型过滤；本站 includeSelfReplies=true，includeReplies 与 resetOnly 为 false；主帖始终开启，纯转推排除。两个回复开关均关闭时只采主帖，分别开启时加采对应类别，都开启时加采全部回复。第三方查询负责回复类别筛选，本地不重复按回复目标账号过滤，缺失账号不丢弃帖子。引用对象及其父帖关系保存为可复用材料，上下文先读取本轮响应和当前监控已存帖子，仍缺失时按明确 ID 付费补采；外部作者和窗口外材料只作上下文，不自动生成官方事实。配置修改后重启 API 与 worker，完整规则见[共享引擎](../reset-monitor/README.md#采集与运行)。

只有配置账号能提供官方动作依据。日常自动重置、条件政策、API 赠金、玩笑和模糊惊喜不生成事件；同帖逐项处理，跨账号关联须有可核验依据。重置卡、直接重置和额外消费额度分开；奖励可领取不代表个人到账，不计入重置次数。

预告、确认、进展、修订是独立动作；取消通过修订的 invalidatesEvent=true 表达。同一事实多帖报道只补来源，同帖可支持多个动作。状态与时间由动作统一推导，后台不能直接改状态或时间；有来源确认没有实际生效时间时取确认来源发布时间，不沿用计划时间。只有 confirm 允许 sources=[]，必须保存明确时间，标题摘要说明人工核实或推定；后续官方确认更新同一动作来源、标题摘要及实际时间，保持 ID。人工确认使用原有动作流程，无独立核实结果或未生效暂停能力。公开 updates 包含无来源确认，不返回独立确认元数据；模型只读取有来源官方动作。各产品共用基于 Temporal 的来源时间解析：PST 固定 UTC−08:00，PT 按 America/Los_Angeles 夏令时规则；不使用作者发放惯例，明确钟点不扩大成区间。

三类事件共用状态和动作；有效 confirm 均为 completed，关闭领取、到期、重开使用 progress，取消使用带 invalidatesEvent=true 的 amend；取消为业务终态，只能更正或删除错误取消动作后重算，普通 amend 不覆盖有效官方确认。新预告、计划修订、延期、取消可使旧无来源确认不再决定当前结果，动作及审计保留。独立分钟任务保存到期预告的推定确认，读页面和 API 不写库；历史先生成确认再建立通知基线，不补通知。动作保存文案、时间、事件内 sequence 和仅含 postId 的 sources，不存结果或范围副本；范围只在事件保存。同一事实明确复用动作 ID，不根据标题摘要哈希合并，歧义转人工复核。补来源不改变 sequence，重排须单独预览提交。

业务只有事件、动作、帖子三张表，不维护帖子事件绑定。帖子保存原文 text、单层随帖引用 quoted_post、七语言标题摘要及原帖链接，不存全文翻译或原始 JSON；运行识别直接读取帖子。原文仅后台管理员可读，不进事件、动作、公开响应或业务审计；供应商响应只存内部付费回执。事件可编辑类型、标题、摘要和范围，管理员撤回只控制公开可见性，没有账户回执确认入口。事件页管理动作，帖子复核用选择器创建事件、添加动作或补来源，不手写 ID；事件、动作、来源、重排分别表达，需预览的操作核验相关记录版本后一次提交。

帖子只保留 pending、processed、needs_attention、failed 四种识别进度及 review_reason，不维护 manual，也不以状态区分有无动作。worker 只识别 pending，写入核验原始版本；动作和来源管理、翻译不改变识别进度，明确完成帖子处理时设 processed 并清空原因。

## 入口

| 入口 | 用途 |
| --- | --- |
| `/codex-reset` | v2 当前结果与北京时间月历 |
| `/codex-reset/history/YYYY-MM-DD` | 北京时间按日事件及动作来源 |
| `/admin/codex-reset` | 事件列表与帖子列表两个 tab，默认事件列表；帖子包含已关联与未关联记录，只保留北京时间日期范围筛选，各自分页 |
| `/admin/codex-reset/events/:id` | 事件详情及动作、来源管理 |
| `/admin/codex-reset/posts/:id/review` | 帖子处理、动作及来源复核 |
| `/api/admin/codex-reset` | 管理员 HTTP API 基础路径 |
| `/api/v2/overview` | 三平台来源、目录、统计和最近事件时间 |
| `/api/v2/codex-resets` | 事件列表及完整动作 `updates` |
| MCP `get_codex_resets`（带站点前缀） | 同一 v2 投影的文本和结构化数据 |

站点通过 HTTP 读取 v2，日历显式传 `timeZone=Asia/Shanghai`；Agent、MCP、飞书和 Webhook 使用同一动作结构及全部来源。监控 v1、旧站点快照及轮询接口删除，无兼容模式。接口细则见[公共额度接口 v2](../../docs/reset-monitor-v2.md)。

所有读写限定 `monitor_id='codex'`，后台仅管理员可用。共享数据结构转换必须先停旧写入、验证备份并按指纹应用，见[部署说明](../../docs/deploy.md#动作模型与-v2-切换)。新代码不能在未转换的旧业务记录上运行。开发与测试只使用本地假服务和独立测试库，不自动执行生产转换、真实调用、推送或部署。
