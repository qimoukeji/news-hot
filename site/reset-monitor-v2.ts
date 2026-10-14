import type { PublicV2Config } from "@aihot/reset-monitor/public-v2";

// Proper product and plan names keep their official spelling in every language.
const name = (en: string) => ({ en, zh: en, "zh-Hant": en, ja: en, ko: en, ru: en, es: en });
const entry = (code: string, en: string) => ({ code, name: name(en) });
const quotaWindows = [
  { code: "five-hour", name: { en: "Five-hour quota", zh: "五小时额度", "zh-Hant": "五小時額度", ja: "5時間の利用枠", ko: "5시간 사용 한도", ru: "Пятичасовой лимит", es: "Cuota de cinco horas" } },
  { code: "weekly", name: { en: "Weekly quota", zh: "周额度", "zh-Hant": "每週額度", ja: "週間利用枠", ko: "주간 사용 한도", ru: "Недельный лимит", es: "Cuota semanal" } },
];

export const RESET_MONITOR_V2 = {
  codex: { platform: "codex", catalog: {
    products: [entry("codex", "Codex"), entry("chatgpt-work", "ChatGPT Work"), entry("chatgpt", "ChatGPT")],
    plans: [entry("free", "Free"), entry("plus", "Plus"), entry("pro", "Pro"), entry("pro-5x", "Pro 5x"), entry("pro-20x", "Pro 20x"), entry("business", "Business"), entry("enterprise", "Enterprise")], quotaWindows,
  } },
  claude: { platform: "claude-code", catalog: {
    products: [entry("claude-code", "Claude Code"), entry("claude", "Claude")],
    plans: [entry("free", "Free"), entry("pro", "Pro"), entry("max", "Max"), entry("max-5x", "Max 5x"), entry("max-20x", "Max 20x"), entry("team", "Team"), entry("enterprise", "Enterprise")], quotaWindows,
  } },
  grok: { platform: "grok", catalog: {
    products: [entry("grok", "Grok"), entry("grok-bot", "Grok Bot"), entry("grok-build", "Grok Build"), entry("grok-imagine", "Grok Imagine")], plans: [], quotaWindows,
  } },
} satisfies Record<string, PublicV2Config>;
