"use client";

import { useEffect, useMemo, useState } from "react";
import { DEPARTMENTS } from "@/lib/departments";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import type { DisplayCall, DisplaySettings, InterviewTable } from "@/lib/types";

export function WaitingDisplay({ initialCalls, initialSettings, initialTables }: {
  initialCalls: DisplayCall[];
  initialSettings: DisplaySettings[];
  initialTables: InterviewTable[];
}) {
  const calls = useRealtimeRows<DisplayCall>("display_calls", initialCalls, "called_at");
  const settings = useRealtimeRows<DisplaySettings>("display_settings", initialSettings, "id");
  const tables = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const refetchCalls = calls.refetch;
  const refetchSettings = settings.refetch;
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    const refresh = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetchCalls();
    }, 3000);
    // Close the gap between server render and the Realtime subscriptions.
    void refetchCalls();
    void refetchSettings();
    return () => { window.clearInterval(timer); window.clearInterval(refresh); };
  }, [refetchCalls, refetchSettings]);

  const mode = settings.rows.find((row) => row.id === "main")?.identity_mode ?? "NAME";
  const tableNames = useMemo(() => new Map(tables.rows.map((table) => [table.id, table.name])), [tables.rows]);
  const grouped = useMemo(() => DEPARTMENTS.map((department) => ({
    department,
    entries: calls.rows
      .filter((call) => call.department === department.code)
      .sort((a, b) => b.called_at.localeCompare(a.called_at) || b.id.localeCompare(a.id))
      .slice(0, 5),
  })), [calls.rows]);

  const live = calls.status === "live" && settings.status === "live" && tables.status === "live";

  return (
    <main className="min-h-dvh overflow-x-auto bg-[#101b19] text-[#f7f5ef]">
      <div className="mx-auto flex min-h-dvh min-w-[1200px] flex-col px-[clamp(24px,3vw,64px)] py-[clamp(24px,3vh,48px)]">
        <header className="flex items-end justify-between gap-8 border-b border-[#52605a] pb-7">
          <div>
            <p className="mb-2 text-sm font-semibold tracking-[0.3em] text-[#c9a67b] uppercase">CLB Casting</p>
            <h1 className="text-[clamp(2.2rem,3.4vw,4.25rem)] leading-none font-semibold tracking-tight">Mời vào phỏng vấn</h1>
          </div>
          <div className="text-right">
            <p className="font-mono text-[clamp(1.5rem,2.3vw,2.8rem)] tabular-nums">
              {now?.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) ?? "--:--"}
            </p>
            <p className="mt-1 text-sm text-[#b6c0b8]">
              {live ? "Đang cập nhật trực tiếp" : calls.status === "offline" || settings.status === "offline" || tables.status === "offline" ? "Mất kết nối, đang thử lại" : "Đang kết nối"}
            </p>
          </div>
        </header>

        <div className="mt-8 grid flex-1 grid-cols-5 gap-[clamp(12px,1.2vw,24px)]">
          {grouped.map(({ department, entries }) => (
            <section key={department.code} className="flex min-h-[540px] flex-col border-l border-[#52605a] pl-[clamp(12px,1.2vw,24px)] first:border-l-0 first:pl-0">
              <div className="h-40 shrink-0 border-b border-[#52605a] pb-5">
                <p className="mb-3 font-mono text-sm tracking-[0.25em] text-[#c9a67b]">{department.code}</p>
                <h2 className="text-balance text-[clamp(1.5rem,1.8vw,2.25rem)] leading-tight font-semibold tracking-tight">{department.name}</h2>
              </div>
              <ol className="grid flex-1 grid-rows-5 gap-3 py-5">
                {Array.from({ length: 5 }, (_, index) => {
                  const entry = entries[index];
                  return <li key={entry?.id ?? `empty-${index}`} className={entry
                    ? "flex min-h-20 items-center justify-center rounded-xl border border-[#ab8c66] bg-[#24322d] px-3 py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                    : "flex min-h-20 items-center justify-center rounded-xl border border-dashed border-[#43514a] px-3 py-3 text-center"}>
                    {entry ? <div className="flex min-w-0 flex-col items-center justify-center gap-1.5">
                      <p className={`max-w-full text-balance font-semibold leading-[1.15] break-words ${
                        (mode === "CODE" ? entry.display_code : entry.display_name).length > 28
                          ? "text-[clamp(1rem,1.15vw,1.4rem)]"
                          : "text-[clamp(1.125rem,1.45vw,1.875rem)]"
                      }`}>
                        {mode === "CODE" ? entry.display_code : entry.display_name}
                      </p>
                      <p className="max-w-full text-balance font-mono text-[clamp(0.95rem,1.1vw,1.35rem)] leading-tight font-semibold tracking-wide text-[#dbbd92]">
                        {entry.room_label}{entry.table_id && tableNames.has(entry.table_id) ? ` · ${tableNames.get(entry.table_id)}` : ""}
                      </p>
                    </div> : <span className="text-sm text-[#718078]">Chờ lượt gọi</span>}
                  </li>;
                })}
              </ol>
              <p className="border-t border-[#52605a] pt-4 text-right font-mono text-sm text-[#b6c0b8]">{entries.length}/5</p>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
