import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { SITE } from "@aihot/site";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { bj } from "@aihot/web/features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, Input, ReasonDialog } from "@aihot/web/features/admin/ui";
import { adminGet } from "@aihot/web/lib/admin.server";
import type { WebhookAdminData, WebhookDelivery, WebhookPlatform, WebhookSubscription } from "../webhooks.ts";

const API = "/api/admin/reset-subscriptions";
const PLATFORM: Record<WebhookPlatform, string> = { codex: "Codex", "claude-code": "Claude", grok: "Grok" };
const PLATFORMS = Object.keys(PLATFORM) as WebhookPlatform[];
const STATUS: Record<WebhookDelivery["status"], string> = { pending: "等待发送", sending: "发送中", sent: "已送达", failed: "已失败", cancelled: "已取消" };
const ACTION: Record<WebhookDelivery["action"], string> = { created: "首次公开", updated: "内容更新", withdrawn: "撤回", restored: "恢复" };
type SubscriptionForm = Pick<WebhookSubscription, "name" | "url" | "platforms">;
type LoaderData = WebhookAdminData & { selectedId: string | null; deliveries: WebhookDelivery[] };
const formOf = ({ name, url, platforms }: WebhookSubscription): SubscriptionForm => ({ name, url, platforms });

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const data = await adminGet<WebhookAdminData>(request, API);
  const requested = new URL(request.url).searchParams.get("subscription");
  const selectedId = data.subscriptions.find(s => s.id === requested)?.id ?? null;
  const result = selectedId ? await adminGet<{ deliveries: WebhookDelivery[] }>(request, `${API}/${encodeURIComponent(selectedId)}/deliveries`) : null;
  return { ...data, selectedId, deliveries: result?.deliveries ?? [] };
}

export const meta = () => [{ title: `事件订阅 · ${SITE.name} 后台` }];

function SubscriptionFields({ value, onChange }: { value: SubscriptionForm; onChange: (value: SubscriptionForm) => void }) {
  return <>
    <Field label="名称"><Input aria-label="名称" required value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} /></Field>
    <Field label="HTTPS 回调地址" hint="填写接收通知的公网地址。"><Input aria-label="HTTPS 回调地址" required type="url" pattern="https://.*" placeholder="https://example.com/webhook" value={value.url} onChange={e => onChange({ ...value, url: e.target.value })} /></Field>
    <fieldset>
      <legend className="mb-2 text-[12.5px] font-medium text-ink-2">订阅平台（至少选择一个）</legend>
      <div className="flex flex-wrap gap-4">
        {PLATFORMS.map(platform => <label key={platform} className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={value.platforms.includes(platform)} onChange={e => onChange({ ...value, platforms: e.target.checked ? [...value.platforms, platform] : value.platforms.filter(p => p !== platform) })} />
          {PLATFORM[platform]}
        </label>)}
      </div>
      {!value.platforms.length && <p role="alert" className="mt-2 text-[12px] text-hot">请选择至少一个平台。</p>}
    </fieldset>
  </>;
}

function SubscriptionCard({ subscription, selected, onSecret }: { subscription: WebhookSubscription; selected: boolean; onSecret: (name: string, secret: string) => void }) {
  const { run, busy } = useAdminAction();
  const [dialog, setDialog] = useState<"edit" | "toggle" | "rotate" | null>(null);
  const [form, setForm] = useState<SubscriptionForm>(() => formOf(subscription));
  const base = `${API}/${encodeURIComponent(subscription.id)}`;
  return <Card>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-semibold text-ink">{subscription.name}</h2><Badge tone={subscription.enabled ? "ok" : "muted"}>{subscription.enabled ? "已启用" : "已停用"}</Badge></div>
        <p className="mt-2 break-all font-mono text-[12px] text-ink-3">{subscription.url}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{subscription.platforms.map(p => <Badge key={p}>{PLATFORM[p]}</Badge>)}</div>
        <p className="mt-2 text-[12px] text-ink-4">更新于 {bj(subscription.updatedAt, true)}{subscription.enabledAt && subscription.enabled ? ` · 本次启用于 ${bj(subscription.enabledAt, true)}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => { setForm(formOf(subscription)); setDialog("edit"); }}>编辑</Button>
        <Button size="sm" disabled={busy} onClick={() => setDialog("toggle")}>{subscription.enabled ? "停用" : "启用"}</Button>
        <Button size="sm" disabled={busy} onClick={() => setDialog("rotate")}>轮换密钥</Button>
        <Link to={`?subscription=${encodeURIComponent(subscription.id)}`} preventScrollReset className={`inline-flex h-7 items-center rounded-control px-2.5 text-[12.5px] ${selected ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-bg-sunk"}`}>投递记录</Link>
      </div>
    </div>
    <ReasonDialog open={dialog === "edit"} title="编辑订阅" description="更换回调地址或平台会取消旧的待发通知。" busy={busy} confirmLabel="保存" onClose={() => setDialog(null)} onSubmit={async reason => {
      if (!form.platforms.length) return false;
      return (await run("PATCH", base, { ...form, enabled: subscription.enabled, reason }, { success: "订阅已更新" })) !== null;
    }}><SubscriptionFields value={form} onChange={setForm} /></ReasonDialog>
    <ReasonDialog open={dialog === "toggle"} title={subscription.enabled ? "停用订阅" : "启用订阅"} description={subscription.enabled ? "停用会取消待发通知；重新启用不会补发停用期间的变化。" : "只接收启用之后的变化，不补发历史通知。"} busy={busy} onClose={() => setDialog(null)} onSubmit={async reason => (await run("PATCH", base, { enabled: !subscription.enabled, reason }, { success: subscription.enabled ? "订阅已停用" : "订阅已启用" })) !== null} />
    <ReasonDialog open={dialog === "rotate"} title="轮换签名密钥" description="旧密钥将失效，旧的待发通知会取消。新密钥只显示一次，请同步更新接收服务。" busy={busy} confirmLabel="轮换" onClose={() => setDialog(null)} onSubmit={async reason => {
      const result = await run<{ secret: string }>("POST", `${base}/rotate-secret`, { reason }, { success: "签名密钥已轮换" });
      if (!result) return false;
      onSecret(subscription.name, result.secret);
      return true;
    }} />
  </Card>;
}

function Deliveries({ subscription, deliveries }: { subscription: WebhookSubscription; deliveries: WebhookDelivery[] }) {
  const { run, busy } = useAdminAction();
  const revalidator = useRevalidator();
  const [retry, setRetry] = useState<WebhookDelivery | null>(null);
  return <Card title={`${subscription.name} · 投递记录`} pad={false} right={<Button size="sm" busy={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}>刷新</Button>}>
    <DataTable rows={deliveries} rowKey={row => row.id} empty="暂无投递记录。启用订阅后发生的事件变化会出现在这里。" columns={[
      { key: "event", label: "事件", render: d => <><div>{PLATFORM[d.platform]} · {ACTION[d.action]}</div><div className="mt-1 break-all font-mono text-[11px] text-ink-4">{d.eventId} · 版本 {d.revision}</div></> },
      { key: "status", label: "状态", render: d => <><Badge tone={d.status === "sent" ? "ok" : d.status === "failed" ? "bad" : d.status === "cancelled" ? "muted" : "warn"}>{STATUS[d.status]}</Badge><div className="mt-1 text-[12px] text-ink-3">已尝试 {d.attempts} 次{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""}</div>{d.lastError && <div className="mt-1 max-w-sm break-words text-[12px] text-hot">{d.lastError}</div>}</> },
      { key: "time", label: "时间（北京）", render: d => <><div>{bj(d.createdAt, true)}</div>{d.sentAt && <div className="mt-1 text-[12px] text-ink-3">送达 {bj(d.sentAt, true)}</div>}{d.nextAttemptAt && d.status === "pending" && <div className="mt-1 text-[12px] text-ink-3">下次 {bj(d.nextAttemptAt, true)}</div>}</> },
      { key: "action", label: "操作", render: d => d.status === "failed" ? <Button size="sm" disabled={busy || !subscription.enabled} onClick={() => setRetry(d)} title={!subscription.enabled ? "请先启用订阅" : undefined}>重新发送</Button> : null },
    ]} />
    <ReasonDialog open={retry !== null} title="重新发送通知" description="保持原通知 ID 和内容。接收服务可能已经收到过该通知，应按通知 ID 去重。" confirmLabel="重新发送" busy={busy} onClose={() => setRetry(null)} onSubmit={async reason => retry ? (await run("POST", `${API}/${encodeURIComponent(subscription.id)}/deliveries/${encodeURIComponent(retry.id)}/retry`, { reason }, { success: "已安排重新发送" })) !== null : false} />
  </Card>;
}

export default function SubscriptionsAdmin({ loaderData }: { loaderData: LoaderData }) {
  const { run, busy } = useAdminAction();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<SubscriptionForm>({ name: "", url: "", platforms: [...PLATFORMS] });
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const selected = loaderData.subscriptions.find(s => s.id === loaderData.selectedId);
  return <AdminPage title="事件订阅" subtitle="订阅 Codex、Claude 和 Grok 事件的首次公开、更新、撤回与恢复。" actions={<Button tone="primary" disabled={busy} onClick={() => { setSecret(null); setForm({ name: "", url: "", platforms: [...PLATFORMS] }); setCreating(true); }}>新增订阅</Button>}>
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2"><Badge tone={loaderData.pushEnabled ? "ok" : "warn"}>{loaderData.pushEnabled ? "通知发送已开放" : "通知发送未开放"}</Badge><span className="text-[13px] text-ink-3">{loaderData.pushEnabled ? "已启用的订阅可以接收通知。" : "发送安全阀默认关闭，开启前不会向外发送通知。"}</span></div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">新建订阅默认停用，启用后只接收之后的变化，不补发历史通知。首次通知等待内容补全或人工核验成功；停用、修改回调地址或平台会取消旧的待发通知。</p>
      </Card>
      {secret && <Card title={`${secret.name} · 签名密钥`} right={<Button size="sm" onClick={() => setSecret(null)}>隐藏密钥</Button>}>
        <p className="mb-3 text-[13px] text-ink-3">请立即复制到接收服务。隐藏或离开页面后无法再次查看。</p>
        <Input aria-label="签名密钥" readOnly value={secret.value} autoComplete="off" spellCheck={false} className="font-mono" />
      </Card>}
      {loaderData.subscriptions.length ? loaderData.subscriptions.map(s => <SubscriptionCard key={s.id} subscription={s} selected={s.id === loaderData.selectedId} onSecret={(name, value) => setSecret({ name, value })} />) : <Card><Empty>暂无订阅。添加回调地址并启用后，即可接收事件通知。</Empty></Card>}
      {selected && <Deliveries key={selected.id} subscription={selected} deliveries={loaderData.deliveries} />}
    </div>
    <ReasonDialog open={creating} title="新增事件订阅" description="创建后处于停用状态。先保存签名密钥并配置好接收服务，再启用订阅。" confirmLabel="创建" busy={busy} onClose={() => setCreating(false)} onSubmit={async reason => {
      if (!form.platforms.length) return false;
      const result = await run<{ subscription: WebhookSubscription; secret: string }>("POST", API, { ...form, reason }, { success: "订阅已创建，默认停用" });
      if (!result) return false;
      setSecret({ name: result.subscription.name, value: result.secret });
      return true;
    }}><SubscriptionFields value={form} onChange={setForm} /></ReasonDialog>
  </AdminPage>;
}
