# when-reset 结构化时间接入

news-hot 保留 `/api/v2/overview`、`/api/v2/<平台>-resets`、`schemaVersion: 2` 及 OpenAPI 文档版本 `2`。这是破坏性契约变更，客户端必须同步升级后再恢复业务投递。when-reset 使用相同结构化时间契约，跨项目检查通过本地合成接口与回调完成。

## 字段与校验

`event.time`、`updates[].time` 以及总览 `announcedResetTime`、`predictedResetTime`、`resetTime` 共用以下对象类型。总览三个字段可为 null；事件和动作的 time 非空。

```ts
type BusinessTime =
  | { kind: "instant"; at: string }
  | { kind: "date"; date: string; timeZone: string }
  | { kind: "range"; from: string; through: string }
  | { kind: "deadline"; at: string };
```

```json
{
  "time": {
    "kind": "range",
    "from": "2026-11-02T05:00:00.123456789Z",
    "through": "2026-11-02T06:00:00Z"
  }
}
```

严格验证四个分支及字段，拒绝 unknown、额外字段、非法日期、非法 IANA 时区、倒置区间以及所有旧字符串。时间戳含完整年份及 UTC 时区，保留小数秒。`publishedAt`、`generatedAt`、Webhook 的 `occurredAt` 仍是 ISO 字符串；动作顺序仍按 publishedAt 倒序、同时间 ID 升序。

## 页面与日历

- 语言与展示时区独立选择，时刻使用 `Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })` 格式化。
- 日期直接展示 date 的年月日，不把它解析为访客时区的午夜，不补造具体时刻；当来源 timeZone 与展示时区不同时注明来源时区。
- 区间保留起止时间；截止时间按用户语言展示“之前”或等价文字。日期没有倒计时的精确目标，deadline 也不能当成已经发生的时刻。
- 日历使用同一个所选时区请求列表。instant/deadline 按 at 归日，range 按 from 归日，date 保留 date 字段。API 决定事件顺序、范围和统计，客户端不重新推算。
- 纯日期当天北京时间18点是 news-hot 的推定确认边界，与来源是否明确具体时刻无关；客户端不补造18点，不自行改变事件状态。

## Webhook 与缓存

载荷的 event 与列表共用结构化时间契约。签名头仍为 `v1=HMAC-SHA256`，必须验证收到的原始请求体，不先重排对象或格式化时间再验签。通知 ID、revision 与去重规则不变。

切换时清除旧接口数据缓存、客户端持久化快照和旧分页游标；服务器不兼容旧格式。旧游标返回400，应从新查询第一页重新获取。旧契约尚未完成或可重试的投递会取消，不重放历史通知，已发送记录保留审计。

## 接入验收

覆盖三平台、七语言、所选时区、跨年、跨日、小数秒、四种时间对象、可空总览、无来源确认、多来源动作、ETag/304及新游标；核验列表和Webhook严格契约一致，切换语言不改变时区，切换时区不改变纯日期，区间和deadline不会退化成精确发生时刻。使用本地合成数据验收，不发送真实通知。
