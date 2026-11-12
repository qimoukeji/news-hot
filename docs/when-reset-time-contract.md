# when-reset 结构化时间接入

news-hot 保留 `/api/v2/overview`、`/api/v2/<平台>-resets`、`schemaVersion: 2` 及 OpenAPI 文档版本 `2`。这是破坏性契约变更，客户端必须同步升级后再恢复业务投递。when-reset 使用相同结构化时间契约，跨项目检查通过本地合成接口与回调完成。

## 字段与校验

`event.time` 与 `updates[].time` 必填，使用以下三个 BusinessTime 分支。`announcedResetTime` 有预告时为该预告 time，无预告时为 null；hasAnnouncement 与之保持一致。`resetTime`、`predictedResetTime` 仍为 UTC ISO 字符串或 null。消费者直接读取，不补时间或转换旧格式。

```ts
type BusinessTime =
  | { kind: "instant"; at: string }
  | { kind: "range"; from: string; through: string }
  | { kind: "deadline"; at: string };

type OverviewTimes = {
  hasAnnouncement: boolean;
  announcedResetTime: BusinessTime | null;
  resetTime: string | null;          // UTC ISO 8601，以 Z 结尾
  predictedResetTime: string | null; // UTC ISO 8601，以 Z 结尾
};
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

BusinessTime 严格验证三个分支与字段，拒绝 date、unknown、null、额外字段、非法时刻、倒置区间和标量字符串。时间戳以 Z 结尾，最多九位小数秒；resetTime、predictedResetTime 拒绝对象。publishedAt、generatedAt、occurredAt 仍为 ISO 字符串。

## 页面与日历

- 语言与展示时区独立选择，时刻使用 `Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })` 格式化。
- 业务时间已在 news-hot 写入时规范化：日期与星期追加 18:00 UTC；无时间预告追加发帖日期 18:00 UTC，首次处理过点取 23:59；异常时间取发帖日期 18:00 UTC 并待处理。客户端不再接收纯日期对象。
- 区间保留起止时间，截止按用户语言展示之前；deadline 不能当作已发生时刻。
- 日历使用所选时区请求列表；instant/deadline 按 at 归日，range 按 from 归日。API 决定顺序、范围和统计，客户端不重新推算。
- hasAnnouncement=true 时直接展示 announcedResetTime；无预告才显示 predictedResetTime。
- news-hot 将 instant/deadline 的 at、range 的 through 保存为自动确认 instant；待处理来源阻断推定。有来源官方确认使用确认帖发布时间。客户端直接消费，不改变状态。
- 总览 resetTime 是最新有效确认的单一生效时刻，最新记录不能确定时刻时返回 null；predictedResetTime 是该点加典型间隔，过期保留原值并提示，不滚动日期或重算预测。

## Webhook 与缓存

普通 amend 的业务时间与预告计划分开：无明确时间时，保存不早于最早有效来源发帖时刻的最近一个 10:00 UTC；当日已过点则顺延次日，恰好到点仍取当天。它不改变预告计划、恢复预告或使已有确认失效；明确新计划和改期使用 announce。

载荷的 event 与列表共用结构化时间契约。签名头仍为 `v1=HMAC-SHA256`，必须验证收到的原始请求体，不先重排对象或格式化时间再验签。通知 ID、revision 与去重规则不变。

切换时清除旧接口数据缓存、客户端持久化快照和旧分页游标；服务器不兼容旧格式。旧游标返回400，应从新查询第一页重新获取。旧契约尚未完成或可重试的投递会取消，不重放历史通知，已发送记录保留审计。

## 接入验收

覆盖三平台、七语言、所选时区、跨年、跨日、小数秒、三种时间对象、hasAnnouncement 与仅无预告时为空的 announcedResetTime、无来源及多来源确认、ETag/304 和新游标；拒绝 date/null/unknown 的事件或动作 time。列表和 Webhook 契约一致，客户端不重新补时间或改变状态。使用本地合成数据，不发送真实通知。
