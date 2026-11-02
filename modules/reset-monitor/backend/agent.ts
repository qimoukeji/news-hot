import { formatBusinessTime } from "../business-time.ts";
import type { ResetSnapshot } from "../public-v2.ts";
import { answer } from "@aihot/backend/publication/agent";
import { monitor } from "./context.ts";
const actionLabels = {
  announce: "预告", confirm: "确认", progress: "进展", amend: "修订",
};
export function monitorAnswer(data: ResetSnapshot) {
  const lines = data.events
    .map((event) => [
      `- ${event.title.zh ?? event.title.en}（${event.status}，${formatBusinessTime(event.time)}）`,
      ...(event.summary ? [`  ${event.summary.zh ?? event.summary.en}`] : []),
      ...(event.scope.note ? [`  影响范围：${event.scope.note.zh ?? event.scope.note.en}`] : []),
      ...event.updates.flatMap((update) => [
        `  - ${update.title.zh ?? update.title.en}（${update.invalidatesEvent ? "取消修订" : actionLabels[update.action]}，${formatBusinessTime(update.time)}）`,
        ...(update.summary ? [`    ${update.summary.zh ?? update.summary.en}`] : []),
        ...update.sources.map((source) => `    原帖：${source.url}`),
      ]),
    ])
    .flat();
  return answer(
    [`# ${monitor().product} 额度动态`],
    lines.length ? lines : ["暂无有效事件。"],
    ["奖励活动开放不表示个人已经到账，实际额度状态以账户显示为准。", "未明确的适用范围不能据此断言覆盖所有用户或所有产品；已知限制以活动说明和来源为准。"],
  );
}
