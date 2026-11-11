import { credential } from "@aihot/backend/config";

export type ReviewMessage = { title: string; description: string };
export type ServerChanIssue =
  | { code: "invalid_key" | "unconfirmed" | "transport" }
  | { code: "http"; status: number }
  | { code: "rejected"; providerCode: number };
export type ServerChanResult =
  | { status: "sent" | "disabled" }
  | { status: "failed" | "unknown"; error: ServerChanIssue };

/** Kept separate from business state so tests can use a local transport with the real valve off. */
export const serverChan = {
  enabled: () => process.env.SERVERCHAN_ENABLED === "true" && credential("integrations", "SERVERCHAN_SENDKEY") !== null,
  send: sendServerChan,
};

export function sendServerChan(message: ReviewMessage): Promise<ServerChanResult> | { status: "disabled" } {
  if (process.env.SERVERCHAN_ENABLED !== "true") return { status: "disabled" };
  return sendServerChanWithTransport(credential("integrations", "SERVERCHAN_SENDKEY"), message, fetch);
}

/** No default transport or credential. The real entry point is sendServerChan. */
export async function sendServerChanWithTransport(sendKey: string | null | undefined, message: ReviewMessage, transport: typeof fetch): Promise<ServerChanResult> {
  const key = sendKey?.trim();
  if (!key || !/^SCT[A-Za-z0-9]+$/.test(key)) return { status: "failed", error: { code: "invalid_key" } };
  let response: Response;
  try {
    response = await transport(`https://sctapi.ftqq.com/${key}.send`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ title: message.title, desp: message.description }),
    });
  } catch {
    // Transport errors may contain the secret-bearing URL; never store or log the original error.
    return { status: "unknown", error: { code: "transport" } };
  }
  if (!response.ok && response.status >= 100 && response.status <= 599) {
    return { status: "failed", error: { code: "http", status: response.status } };
  }
  if (response.ok) try {
    const result = await response.json() as { code?: unknown } | null;
    if (result?.code === 0) return { status: "sent" };
    if (typeof result?.code === "number" && Number.isSafeInteger(result.code)) {
      return { status: "failed", error: { code: "rejected", providerCode: result.code } };
    }
  } catch {
    // A successful HTTP response with an unreadable body does not confirm delivery.
  }
  return { status: "unknown", error: { code: "unconfirmed" } };
}
