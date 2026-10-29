# 事件 Webhook 订阅

事件 `scope` 复用公开 v2 范围契约。明确动作可以在范围尚未完整映射时建立或关联事件：未知用户使用 `type=unknown` 与七语言说明中的“unknown 所有用户”，未知产品使用 `productCodes=[]` 与“unknown 所有产品”，两者可组合。unknown 表示该维度未限定查询范围，不证明实际覆盖全部；已知代码及摘要中的实际限制继续保留。Webhook 不把空代码数组补成平台默认产品，也不移除 unknown 标签；范围补全仍按现有事件指纹生成更新，签名、修订和去重规则不变。载荷形状及 schemaVersion=2 保持不变。

后台人工创建帖子不创建事件或动作，也不推送通知。帖子标题摘要编辑保留识别进度和已有来源关系；Webhook 始终比较事件公开载荷，不因仅后台可见的帖子文案发生变化而生成通知。帖子成为动作来源后，沿现有事件变更流程推送。

后台独立创建事件只保存事件信息，不发送通知。没有有效初始动作的草稿经过定时扫描、翻译或通知基线初始化，仍不视作历史待补译事件；管理员添加首个有效动作且公开文案准备完成后，发送一次 created。重复扫描和后续编辑沿用同一事件修订去重，不提前推送空事件。

事件载荷与 v2 列表共用动作契约：`confirm` 允许 `sources=[]`，表示没有关联官方帖子，标题或摘要说明“已到预告时间”或“人工核实已生效”；其他动作必须有来源。不返回 `confirmation`、`method`、`outcome` 或独立人工结论，程序不解析标题摘要区分人工与推定。到时推定、人工添加或更正确认、后续官方补证均通过事件动作变化发送 `updated`；人工理由和操作者仅保留在内部审计。

每分钟独立确认检查持久保存到期预告的无来源确认，使用现有事件指纹和修订号，重复检查、重启不重复生成动作或发送通知。首次启用时先为历史到期预告生成确认，再建立当前通知基线，保留既有修订号，不补发历史内容。读取页面或接口不生成确认动作，公开变化在下一分钟检查后出现，并受最长 60 秒缓存影响。

管理员在 `/admin/reset-subscriptions` 添加 HTTPS 回调地址，选择 Codex、Claude、Grok。新订阅默认停用，创建时保存一次性展示的签名密钥，在接收服务配置完成后启用。发送还需要 `WEBHOOK_PUSH_ENABLED=true`，默认关闭；开启安全阀、生产迁移及部署须分别获得授权。

首次通知等待当前动作对应的 v2 文案补全或人工核验成功。后续状态、时间、范围、标题、摘要和动作来源发生变化会发送 `updated`；相同公开结果重复保存不会产生通知。自动处理和人工更正均适用。已经产生通知的事件管理撤回发送 `withdrawn`；恢复等待有效 v2 内容，再发送 `restored`。官方取消保留事件，通过 `amend` 动作的 `invalidatesEvent=true` 推导为 `cancelled`；失效事件退出总览时间及统计。通知内容与 v2 列表的事件对象一致，不包含内部识别结果、原文或模型信息。

首次安装只为历史事件建立基线，不发送历史内容；既有但尚未补全的事件首次补全也只建立基线。订阅启用后只接收之后的变化。停用、更换地址或平台会取消旧的待发通知；重新启用不补发停用期间的变化。轮换密钥也取消使用旧密钥的待发通知。管理操作会等待已经在发送的请求结束，随后取消未发送的旧任务。

## 回调协议

请求为 `POST`，`Content-Type: application/json`，请求体的七语言字段沿用 v2 格式。`platform` 为 `codex`、`claude-code` 或 `grok`。

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 固定为 2 |
| id | 通知 UUID，重试和人工重发不变 |
| occurredAt | 本次公开变化的记录时间，UTC ISO 8601 |
| platform | 平台标识 |
| eventId | 事件 ID，与 platform 一起标识事件 |
| revision | 同一平台、同一事件单调递增的通知版本，允许跳号 |
| action | created、updated、withdrawn、restored |
| event | v2 列表事件对象，不包含 bonusCredit；withdrawn 时为 null |

`event.updates` 是完整动作时间线，包含动作 ID、`announce`／`confirm`／`amend`／`progress`、`invalidatesEvent`、七语言标题摘要、业务时间 `time`、发布时间及全部 `sources: [{postId,sourceId,url}]`。`time` 保留精确时间、日期或区间，未明确时为 null，不以发布时间代替。只有 `confirm` 可返回空数组；有来源时 `publishedAt` 取最早有效来源发布时间，无来源时取动作创建时间，不冒充生效时间。后续官方确认补充同一动作的来源、标题摘要及实际时间，保持动作 ID，通知修订号递增，事件不重复计数。

三类事件共用状态与动作规则，关闭领取、到期、重开使用 progress，取消使用 amend 的 invalidatesEvent=true，取消为业务终态，只能更正或删除错误取消动作后重算；普通 amend 不覆盖有效官方确认，新预告、计划修订、延期、取消可使旧无来源确认不再决定当前结果。同帖可支持多个动作，多帖可支持同一动作，原帖链接使用已保存值；不返回动作 result 或 scope。接口地址、schemaVersion=2 和签名协议不变，严格客户端须接受空来源确认、仅四种业务动作并移除旧判定元数据。Webhook 的外层 `action=restored` 仍表示管理撤回后的可见性恢复，与已取消业务无关，继续保留。切换时清理旧格式待发通知并建立当前基线，不补发历史消息；不保留旧载荷兼容模式。数据版本与请求头的签名算法版本分别管理。

撤回只提供通知 ID、事件 ID、平台和版本；接收方应撤下对应事件。恢复后的 `event` 提供完整当前内容。通知不包含总览的预测时间；明确计划到期后，由分钟任务新增确认动作引起状态变化，不由读取请求直接推断。

| 请求头 | 含义 |
| --- | --- |
| X-Webhook-Id | 与请求体 id 相同 |
| X-Webhook-Timestamp | 本次发送的 Unix 秒时间戳，每次重试重新生成 |
| X-Webhook-Signature | `v1=` 加 HMAC-SHA256 十六进制签名 |

签名内容为 `timestamp + "." + rawBody`，使用订阅密钥的 UTF-8 字节作为 HMAC key。验签必须使用收到的原始请求体，不要先解析再序列化。使用常量时间比较，并检查时间戳与本地时间的差值（建议五分钟以内）。密钥仅创建或轮换时返回，列表、投递记录和审计均不提供密钥。

## 确认与重试

接收方应先持久保存通知，再尽快返回任意 2xx。非 2xx、超时或网络错误均视为失败。回调超时 10 秒，不跟随重定向，只允许公网 HTTPS；即使采集允许私网，Webhook 仍禁止私网连接。响应正文不进入投递记录。

回调地址保存校验与实际投递共用出站解析规则。配置 `EGRESS_PROXY_URL` 后，适用代理的域名使用代理 DNS 解析，并将连接固定到已校验的公网 IP；未配置时使用系统 DNS。本机代理使用 Fake-IP 时需要配置代理地址，不能将 `198.18.0.0/15` 当作公网放行。此配置不改变 HTTPS、公网地址与禁止重定向的限制。

失败后按 30 秒、2 分钟、10 分钟、1 小时延迟重试，最多五次发送。进程停止、队列故障或关闭安全阀期间发送会延后；worker 恢复后扫描持久待发记录继续处理。安全阀关闭不会丢弃待发记录，再次开启会继续发送这些记录。管理员可在投递记录中重发当前启用订阅的失败通知，重新开始最多五次尝试，通知 ID 与原始载荷不变。

超时可能发生在接收方已经保存通知之后，因此为至少一次投递。接收方必须按 `id` 去重，按 `(platform,eventId,revision)` 忽略迟到的旧版本；不同通知到达顺序不保证一致。

## 管理接口

全部接口要求管理员会话，写请求要求 CSRF token 和非空 `reason`；响应不缓存。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/admin/reset-subscriptions | 订阅列表与发送开关状态 |
| POST /api/admin/reset-subscriptions | 创建订阅；name、url、platforms、reason，默认停用；返回 subscription 和一次性 secret |
| PATCH /api/admin/reset-subscriptions/:id | 修改 name、url、platforms、enabled，未提供字段保持原值 |
| POST /api/admin/reset-subscriptions/:id/rotate-secret | 轮换签名密钥，返回一次性 secret |
| GET /api/admin/reset-subscriptions/:id/deliveries | 最近 100 条投递，包含状态、尝试次数和脱敏错误 |
| POST /api/admin/reset-subscriptions/:id/deliveries/:deliveryId/retry | 重发失败投递，通知 ID 不变 |

实现位于共享监控模块：`webhooks.ts` 定义协议，`backend/webhook-events.ts` 与业务事务一起记录变化，`backend/webhooks.ts` 管理订阅和投递。站点仅注册一次管理页面、队列和恢复扫描。已有飞书群通知独立运行，行为不变。
