import type { ResetSnapshot } from "../public-v2.ts";
import { answer } from "@aihot/backend/publication/agent";
import { monitor } from "./context.ts";
const actionLabels = {
  announce: "预告", confirm: "确认", progress: "进展", amend: "修订",
};
export function monitorAnswer(data: ResetSnapshot) {
  const lines = data.events
    .map((event) => [
      `- ${event.title.zh ?? event.title.en}（${event.status}，${event.time}）`,
      ...(event.summary ? [`  ${event.summary.zh ?? event.summary.en}`] : []),
      ...(event.scope.note ? [`  影响范围：${event.scope.note.zh ?? event.scope.note.en}`] : []),
      ...event.updates.flatMap((update) => [
        `  - ${update.title.zh ?? update.title.en}（${update.invalidatesEvent ? "取消修订" : actionLabels[update.action]} · ${update.action}，${update.publishedAt}）`,
        ...(update.summary ? [`    ${update.summary.zh ?? update.summary.en}`] : []),
        ...update.sources.map((source) => `    原帖：${source.url}`),
      ]),
    ])
    .flat();
  return answer(
    [`# ${monitor().product} 额度动态`],
    lines.length ? lines : ["暂无有效事件。"],
    ["三类事件共用状态与动作。关闭领取、到期、重开记录为进展；取消使用带 invalidatesEvent 标记的修订，失效事件保留历史但不参与总览和统计。奖励确认不表示个人已经到账。", "影响范围中的 unknown 表示该维度无法明确或完整映射，不能据此断言覆盖所有用户或所有产品；已知限制仍以摘要和范围代码为准。"],
  );
}
