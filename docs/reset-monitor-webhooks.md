# 事件 Webhook 订阅

管理员在 `/admin/reset-subscriptions` 添加 HTTPS 回调地址，选择 Codex、Claude、Grok。新订阅默认停用，创建时保存一次性展示的签名密钥，在接收服务配置完成后启用。发送还需要 `WEBHOOK_PUSH_ENABLED=true`，默认关闭；开启安全阀、生产迁移及部署须分别获得授权。

首次通知等待当前证据对应的 v2 内容补全或人工核验成功。后续状态、时间、范围、标题、摘要和业务更新发生变化会发送 `updated`；相同公开结果重复保存不会产生通知。自动处理和人工更正均适用。已经产生通知的事件撤回发送 `withdrawn`；恢复等待有效 v2 内容，再发送 `restored`。通知内容与 v2 列表的事件对象一致，不包含内部证据、识别结果或模型信息。

首次安装只为历史事件建立基线，不发送历史内容；既有但尚未补全的事件首次补全也只建立基线。订阅启用后只接收之后的变化。停用、更换地址或平台会取消旧的待发通知；重新启用不补发停用期间的变化。轮换密钥也取消使用旧密钥的待发通知。管理操作会等待已经在发送的请求结束，随后取消未发送的旧任务。

## 回调协议

请求为 `POST`，`Content-Type: application/json`，请求体的七语言字段沿用 v2 格式。`platform` 为 `codex`、`claude-code` 或 `grok`。

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 固定为 1 |
| id | 通知 UUID，重试和人工重发不变 |
| occurredAt | 本次公开变化的记录时间，UTC ISO 8601 |
| platform | 平台标识 |
| eventId | 事件 ID，与 platform 一起标识事件 |
| revision | 同一平台、同一事件单调递增的通知版本，允许跳号 |
| action | created、updated、withdrawn、restored |
| event | v2 列表事件对象，不包含 bonusCredit；withdrawn 时为 null |

撤回只提供通知 ID、事件 ID、平台和版本；接收方应撤下对应事件。恢复后的 `event` 提供完整当前内容。通知不包含总览的预测时间，时间经过本身不触发状态变化。

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
