import { Link } from "react-router";
import type { EventList } from "../../public-v2.ts";
import { useMonitor } from "../context.tsx";
import { eventDate } from "./format.ts";

export function ResetCalendar({ events, month, selectedDate, today, onSelectDate }: { events: EventList["list"]; month: string; selectedDate: string | null; today: string; onSelectDate: (date: string | null) => void }) {
  const { pagePath } = useMonitor();
  const [year, number] = month.split("-").map(Number) as [number, number];
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const adjacent = (delta: number) => new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
  const counts = new Map<string, number>();
  for (const event of events) { const day = eventDate(event.time); counts.set(day, (counts.get(day) ?? 0) + 1); }
  return <section aria-label="事件日历" className="rounded-card border border-line bg-surface p-4">
    <div className="mb-4 flex items-center justify-between text-[13px]">
      <Link className="text-accent" to={`${pagePath}?month=${adjacent(-1)}`}>← 上月</Link>
      <button type="button" className="font-semibold text-ink" onClick={() => onSelectDate(null)}>{month}</button>
      <Link className="text-accent" to={`${pagePath}?month=${adjacent(1)}`}>下月 →</Link>
    </div>
    <div className="grid grid-cols-7 gap-1 text-center text-[12px]">
      {["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day} className="py-1 text-ink-4">{day}</span>)}
      {Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} />)}
      {Array.from({ length: days }, (_, i) => {
        const day = `${month}-${String(i + 1).padStart(2, "0")}`;
        const count = counts.get(day) ?? 0;
        return <button type="button" title={`${day}：${count} 个事件`} aria-label={`${day}${count ? `，${count} 个事件` : "，无事件"}`} aria-current={selectedDate === day ? "date" : undefined} aria-pressed={selectedDate === day} key={day} onClick={() => onSelectDate(day)} className={`rounded-control py-2 ${selectedDate === day ? "bg-ink text-bg" : day === today ? "bg-accent/10 text-accent" : "text-ink-3 hover:bg-bg-sunk"}`}>
          <span>{i + 1}</span><span aria-hidden="true" className={`mx-auto mt-1 block size-1 rounded-full ${count ? "bg-accent" : "bg-transparent"}`} />
        </button>;
      })}
    </div>
    <p className="mt-3 text-[12px] text-ink-4">圆点表示当天有事件，按北京时间归日。</p>
  </section>;
}
