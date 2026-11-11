"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CircleHelp, LogOut, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { DEPARTMENTS } from "@/lib/departments";
import { formatDateTime, normalizeText } from "@/lib/format";
import type { ReviewDecisionValue, RubricCriterion } from "@/lib/types";
import type { ReviewCandidate } from "@/lib/reviews/server";
import { leaveReviewPortal, saveReviewDecision } from "./actions";

const CHOICES: { value: ReviewDecisionValue; label: string; icon: typeof Check; className: string }[] = [
  { value: "PASS", label: "Đỗ", icon: Check, className: "border-emerald-600 bg-emerald-600 text-white" },
  { value: "CONSIDER", label: "Cân nhắc", icon: CircleHelp, className: "border-amber-500 bg-amber-500 text-white" },
  { value: "FAIL", label: "Trượt", icon: X, className: "border-rose-600 bg-rose-600 text-white" },
];

export function ReviewWorkspace({ department, initialRows, criteria }: {
  department: (typeof DEPARTMENTS)[number];
  initialRows: ReviewCandidate[];
  criteria: RubricCriterion[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const search = normalizeText(useDeferredValue(query));
  const [filter, setFilter] = useState<"ALL" | "UNSET" | ReviewDecisionValue>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => setRows(initialRows), [initialRows]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 30000);
    return () => window.clearInterval(timer);
  }, [router]);

  const selected = rows.find((row) => row.id === selectedId);
  const counts = useMemo(() => ({
    all: rows.length, unset: rows.filter((row) => !row.decision).length,
    pass: rows.filter((row) => row.decision?.decision === "PASS").length,
    consider: rows.filter((row) => row.decision?.decision === "CONSIDER").length,
    fail: rows.filter((row) => row.decision?.decision === "FAIL").length,
  }), [rows]);
  const visible = useMemo(() => rows.filter((row) => {
    if (filter === "UNSET" && row.decision) return false;
    if (filter !== "ALL" && filter !== "UNSET" && row.decision?.decision !== filter) return false;
    return !search || normalizeText(`${row.full_name} ${row.code} ${row.shift ?? ""}`).includes(search);
  }).sort((a, b) => Number(b.evaluation?.average_score ?? -1) - Number(a.evaluation?.average_score ?? -1)
    || a.full_name.localeCompare(b.full_name, "vi")), [rows, filter, search]);

  async function decide(row: ReviewCandidate, decision: ReviewDecisionValue, note?: string) {
    if (busyId) return;
    setBusyId(row.id);
    const result = await saveReviewDecision(department.code, row.id, decision, note ?? notes[row.id] ?? row.decision?.note ?? "");
    setBusyId(null);
    if (!result.ok) return toast.error(result.error);
    setRows((current) => current.map((item) => item.id === row.id ? {
      ...item, decision: { id: item.decision?.id ?? row.id, candidate_id: row.id, department: department.code,
        decision, note: note ?? notes[row.id] ?? row.decision?.note ?? "", portal_generation: item.decision?.portal_generation ?? "",
        decided_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    } : item));
    toast.success(`Đã lưu ${row.full_name}: ${CHOICES.find((choice) => choice.value === decision)?.label}`);
    router.refresh();
  }

  async function leave() {
    await leaveReviewPortal(department.code);
    router.refresh();
  }

  return <div className="app-page text-foreground">
    <header className="sticky top-0 z-40 border-b bg-card/95 shadow-sm backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1"><p className="font-mono text-xs font-semibold tracking-widest text-muted-foreground">CLB CASTING <span className="mx-1 text-border">/</span> {department.code}</p>
          <h1 className="truncate text-base font-semibold sm:text-lg">Chốt kết quả · {department.name}</h1></div>
        <Button variant="outline" size="sm" onClick={() => void leave()}><LogOut /> <span className="hidden sm:inline">Đóng phiên</span></Button>
      </div>
    </header>
    <main className="mx-auto max-w-[1680px] space-y-5 px-4 py-5 sm:px-6 sm:py-7">
      <div className="app-panel grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-5">
        {([ ["Đã phỏng vấn", counts.all], ["Chưa chốt", counts.unset], ["Đỗ", counts.pass],
          ["Cân nhắc", counts.consider], ["Trượt", counts.fail] ] as const).map(([label, value]) =>
          <div key={label} className="bg-card px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p></div>)}
      </div>
      <div className="app-sticky-toolbar -mx-4 flex flex-wrap gap-2 px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="relative min-w-0 flex-1 sm:min-w-60"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Tìm tên, mã ứng viên hoặc ca…" className="h-10 border-input bg-background pl-9" /></div>
        <select className="h-10 max-w-full rounded-md border border-input bg-background px-3 text-sm" value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label="Lọc kết quả">
          <option value="ALL">Tất cả</option><option value="UNSET">Chưa chốt</option>
          <option value="PASS">Đỗ</option><option value="CONSIDER">Cân nhắc</option><option value="FAIL">Trượt</option>
        </select>
      </div>
      <div className="app-panel overflow-hidden">
        <div className="hidden grid-cols-[7rem_minmax(0,1fr)_6rem_9rem_15rem] gap-3 border-b bg-muted/60 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
          <span>Mã</span><span>Thí sinh</span><span>Điểm</span><span>Kết quả</span><span>Chốt nhanh</span>
        </div>
        <div className="divide-y divide-border">
          {visible.map((row) => <div key={row.id} className="grid gap-3 p-4 transition-colors hover:bg-muted/20 md:grid-cols-[7rem_minmax(0,1fr)_6rem_9rem_15rem] md:items-center">
            <span className="font-mono text-sm text-muted-foreground">{row.code}</span>
            <button type="button" onClick={() => setSelectedId(row.id)} className="min-w-0 text-left hover:underline">
              <span className="block font-semibold">{row.full_name}</span><span className="text-xs text-muted-foreground">{row.shift || "Không có ca"} · Xem phiếu chấm</span>
            </button>
            <span className="font-mono text-lg font-semibold tabular-nums">{row.evaluation?.average_score == null ? "—" : Number(row.evaluation.average_score).toFixed(2)}</span>
            <span className="text-sm font-medium">{row.decision ? CHOICES.find((choice) => choice.value === row.decision?.decision)?.label : "Chưa chốt"}</span>
            <div className="flex gap-1">
              {CHOICES.map((choice) => <button key={choice.value} type="button" disabled={busyId !== null}
                onClick={() => void decide(row, choice.value)} title={choice.label}
                aria-label={`${choice.label}: ${row.full_name}`} aria-pressed={row.decision?.decision === choice.value}
                className={`inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-md border text-xs font-medium transition-colors disabled:opacity-50 ${
                  row.decision?.decision === choice.value ? choice.className : "border-border bg-background hover:bg-muted"}`}>
                <choice.icon className="size-4" /><span className="sr-only sm:not-sr-only">{choice.label}</span>
              </button>)}
            </div>
          </div>)}
          {visible.length === 0 && <p className="px-4 py-16 text-center text-sm text-muted-foreground">Không có thí sinh phù hợp bộ lọc.</p>}
        </div>
      </div>
    </main>

    <Dialog open={!!selectedId} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {selected && <><DialogHeader><DialogTitle>{selected.full_name}</DialogTitle>
          <DialogDescription>{selected.code} · {selected.shift || "Không có ca"} · {selected.evaluation?.table_label || "Chưa ghi nhận bàn"}</DialogDescription>
        </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between border-b pb-3"><span>Điểm trung bình</span>
              <strong className="font-mono text-2xl">{selected.evaluation?.average_score == null ? "—" : Number(selected.evaluation.average_score).toFixed(2)}/10</strong></div>
            <div className="divide-y rounded-lg border">{criteria.map((criterion) => <div key={criterion.id} className="flex justify-between gap-3 px-3 py-2">
              <span>{criterion.name}</span><span className="shrink-0 font-mono font-semibold">{selected.evaluation?.scores?.[criterion.id] ?? "—"}/{criterion.max_score}</span>
            </div>)}</div>
            <div><p className="mb-1 font-medium">Nhận xét của giám khảo</p>
              <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3">{selected.evaluation?.comment || "(Không có)"}</p></div>
            <p className="text-xs text-muted-foreground">Kết thúc phỏng vấn: {formatDateTime(selected.evaluation?.ended_at ?? selected.interview_ended_at) || "—"}</p>
            <div><label htmlFor="review-note" className="mb-1 block font-medium">Ghi chú khi chốt</label>
              <Textarea id="review-note" value={notes[selected.id] ?? selected.decision?.note ?? ""} maxLength={2000}
                onChange={(event) => setNotes((current) => ({ ...current, [selected.id]: event.target.value }))}
                placeholder="Lý do cân nhắc hoặc lưu ý của Ban…" className="min-h-24" /></div>
            <div className="grid grid-cols-3 gap-2">{CHOICES.map((choice) => <Button key={choice.value} variant={selected.decision?.decision === choice.value ? "default" : "outline"}
              disabled={busyId !== null} onClick={() => void decide(selected, choice.value)}><choice.icon /> {choice.label}</Button>)}</div>
            {selected.decision && <Button variant="ghost" disabled={busyId !== null} className="w-full" onClick={() => void decide(selected, selected.decision!.decision)}>
              Lưu ghi chú</Button>}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
