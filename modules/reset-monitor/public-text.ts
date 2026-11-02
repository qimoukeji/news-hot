import type { ResetEvent } from "./public-v2.ts";

// Match operational phrases, not words such as 人工智能 or product verification features.
const operations = [
  /人工\s*(?:核实|核實|核驗|核验|確認|确认|验证|驗證|校验|校驗|核对|核對|复核|複核|检查|檢查|审核|審核|补录|補錄|录入|錄入|判定|创建|創建)|(?:验证|驗證|校验|校驗)(?:逻辑|邏輯|流程)|模型(?:\s|已|已经|已經)*(?:判断|判斷|判定|核实|核實)/,
  /(?<!企业|企業|组织|組織|团队|團隊|工作区|工作區|租户|租戶)(?:管理员|管理員)(?:\s*(?:已|已经|已經|经|經|进行了|進行了|进行|進行|手动|手動))+(?:判断|判斷|判定|核实|核實|核验|核驗|确认|確認|验证|驗證|校验|校驗|核对|核對|复核|複核|补录|補錄)(?!\s*(?:领取|領取|资格|資格|身份|权限|權限|受众|受眾|成员|成員|用户|用戶))|按(?:照)?(?:后台|後台)?(?:管理员|管理員)(?:的)?要求\s*(?:补录|補錄|录入|錄入|更正)/,
  /manual(?:ly)?[\s-]+(?:verified|verification|confirmed|confirmation|checked|validated|validation|reviewed|review|entered|entry|recorded|approved)|(?:verification|validation) (?:logic|pipeline|workflow)|model (?:judgment|judgement)|administrator request|recorded without an associated post|(?:verified|checked|confirmed) by (?:an? )?(?:administrator|admin|human)/i,
  /手動(?:で)?(?:確認|検証|入力)|管理者(?:が|により|による)?(?:確認|検証)(?:済み|完了|しました)|수동(?:으로)?\s*(?:확인|검증|입력)|관리자(?:가|에 의해)?\s*(?:확인|검증)\s*(?:완료|했습니다|됨)/,
  /ручн\S*\s+(?:проверк|подтвержд)|(?:проверен|подтвержд[её]н)\S*\s+вручную|verificaci[oó]n manual|(?:confirmad|verificad|revisad)[oa] manualmente/i,
  /已记录确认.*关联帖子|已記錄確認.*關聯|関連投稿のない確認記録|연결된 게시물 없이 기록|Подтверждение записано без|Confirmación registrada sin/i,
];
export function hasOperationalText(value: Record<string, string | undefined> | null | undefined): boolean {
  return Object.values(value ?? {}).some(text => !!text && operations.some(pattern => pattern.test(text)));
}
export const accountStatusSummary = {
  en: "Check your account for the actual quota status.", zh: "实际额度状态以账户显示为准", "zh-Hant": "實際額度狀態以帳戶顯示為準",
  ja: "実際の利用枠の状況はアカウントの表示をご確認ください。", ko: "실제 사용 한도 상태는 계정 표시를 확인하세요.",
  ru: "Фактический статус лимита проверяйте в своём аккаунте.", es: "Consulta tu cuenta para comprobar el estado real de la cuota.",
};
export const quotaStatusTitle = {
  en: "Quota status updated", zh: "额度状态已更新", "zh-Hant": "額度狀態已更新", ja: "利用枠の状況が更新されました",
  ko: "사용 한도 상태가 업데이트되었습니다", ru: "Статус лимита обновлён", es: "Estado de la cuota actualizado",
};
export function cleanEventText(event: ResetEvent, title: ResetEvent["title"], actionTitle: (action: ResetEvent["updates"][number]) => ResetEvent["title"]): ResetEvent {
  return { ...event, title: hasOperationalText(event.title) ? title : event.title, summary: hasOperationalText(event.summary) ? null : event.summary,
    scope: { ...event.scope, note: hasOperationalText(event.scope.note) ? null : event.scope.note },
    updates: event.updates.map(update => {
      return { ...update, title: hasOperationalText(update.title) ? actionTitle(update) : update.title,
        summary: hasOperationalText(update.summary) ? null : update.summary };
    }),
  };
}
