import type { ContextInput, Recognition } from "@aihot/reset-monitor/backend/recognize";

// Actual collected source and model output; receipt ID is replaced for the isolated test database.
export const cloudBonus = {
  "id": "2107542088653115603",
  "text": "You can still claim the one time bonus credit for cloud sessions if you were on a Pro or Max plan on Sept 23. Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.\n\nCloud sessions use this credit first, then count toward your plan limits once it runs out or expires Nov 4.\n\nhttp://support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion",
  "publishedAt": "2026-10-06T18:42:44.000Z",
  "context": [
    {
      "id": "2107542087243907506",
      "text": "Cloud sessions run Claude Code on a fresh VM for each task, so you can start several at once and they keep going when you close your laptop.\n\nWe wrote a field guide with seven workflows that suit them, plus how to connect GitHub on the first try.\n\nhttps://claude.dev/blog/claude-code-in-the-cloud",
      "author": "ClaudeDevs",
      "relation": "reply",
      "publishedAt": "2026-10-06T18:42:44.000Z"
    }
  ],
  "recognition": {
    "model": "default",
    "outage": null,
    "relevant": true,
    "contextZh": [
      {
        "id": "2107542087243907506",
        "textZh": "云会话会为每个任务在全新的虚拟机上运行 Claude Code，因此你可以同时启动多个，而且即使你合上笔记本电脑它们也会继续运行。\n\n我们写了一份实战指南，介绍了适合它们的七种工作流，以及如何一次就成功连接 GitHub。\n\nhttps://claude.dev/blog/claude-code-in-the-cloud"
      }
    ],
    "receiptId": 0,
    "needsReview": false,
    "propositions": [
      {
        "kind": "reset_credit",
        "real": true,
        "role": "action",
        "count": 1,
        "scope": {
          "plans": [
            "Pro",
            "Max"
          ],
          "audienceZh": "在 9 月 23 日时为 Pro 或 Max 套餐的用户",
          "productsZh": "Claude Code（云会话）",
          "audienceSource": "if you were on a Pro or Max plan on Sept 23"
        },
        "action": "announce",
        "excerpt": "You can still claim the one time bonus credit for cloud sessions if you were on a Pro or Max plan on Sept 23. Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.",
        "excerptZh": "如果你在 9 月 23 日时是 Pro 或 Max 套餐，你仍然可以领取云会话的一次性奖励额度。请在 10 月 7 日太平洋时间晚上 11:59 前在 Claude Code 中运行 /claim-credit。",
        "relatesTo": null,
        "statedTime": {
          "date": "2026-10-07",
          "clock": "23:59",
          "period": null,
          "timezone": "PT",
          "dayOffset": null,
          "precision": "deadline",
          "clockThrough": null,
          "relativeHours": null
        },
        "duplicateOf": null,
        "kindExplicit": true,
        "timeInferred": false,
        "timeSourceId": "2107542088653115603",
        "expectedLanding": null
      }
    ],
    "promptVersion": "claude-reset-2026-10-10.1",
    "translationZh": "如果你在 9 月 23 日时是 Pro 或 Max 套餐，你仍然可以领取云会话的一次性奖励额度。请在 10 月 7 日太平洋时间晚上 11:59 前在 Claude Code 中运行 /claim-credit。\n\n云会话会先使用这笔额度，用完后或 11 月 4 日过期后，才会计入你的套餐限额。\n\nhttp://support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion"
  }
} satisfies { id: string; text: string; publishedAt: string; context: ContextInput[]; recognition: Recognition };
