import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "codex-reset",
  pages: [
    { path: "codex-reset", file: "web/page.tsx", id: "codex-reset" },
    { path: "codex-reset/history/:date", file: "web/page.tsx", id: "codex-reset-day" },
  ],
  adminPages: [
    { path: "admin/monitor", file: "web/admin.tsx" },
    { path: "admin/monitor/posts/:id/review", file: "web/review.tsx" },
  ],
  apiPaths: [/^\/api\/(?:site\/codex-reset|v1\/codex-resets|admin\/monitor)(?:\/|$)/],
});
