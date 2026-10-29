import { useEffect, useState } from "react";
import type { AdminReviewDetail } from "./admin-types.ts";

export function useReviewDetail(url: string, kind: "event" | "post") {
  const [detail, setDetail] = useState<AdminReviewDetail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError("");
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
        if (response.status === 401) { window.location.href = `/api/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`; return; }
        const value = await response.json() as AdminReviewDetail & { detail?: string };
        if (!response.ok || !value?.[kind] || !Array.isArray(value.actions) || !value.options) throw new Error(value?.detail ?? "读取记录失败，请重试");
        if (!controller.signal.aborted) setDetail(value);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取记录失败，请重试"); }
    })();
    return () => controller.abort();
  }, [url, kind, revision]);
  return { detail, error, revision, reload: () => setRevision(value => value + 1) };
}
