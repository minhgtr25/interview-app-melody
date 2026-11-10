"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, ClipboardList, DoorOpen, RotateCcw, Search, UserRound } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { DepartmentRadio } from "@/components/department-radio";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { DEPARTMENTS, type DepartmentCode } from "@/lib/departments";
import { formatDateTime, formatDuration, normalizeText, safeUrl } from "@/lib/format";
import { dayLabel, todayInVietnam } from "@/lib/interview-days";
import { STATUS_LABEL, type Candidate, type CandidateDayHistory, type CandidateStatus, type Evaluation, type InterviewTable, type Room, type RubricCriterion } from "@/lib/types";
import { createCandidateApplicationStatusResolver } from "@/lib/candidate-application-status";
import { candidateApplicationDay, candidateApplicationShift } from "@/lib/candidate-application-day";
import { cn } from "@/lib/utils";

export function OperationsBoard({ role, staffName, initialCandidates, initialAbsenceHistory, initialEvaluations, initialTables, initialRooms, criteria }: {
  role: "ADMIN" | "SUPPORT_IT" | "COORDINATOR";
  staffName: string;
  initialCandidates: Candidate[];
  initialAbsenceHistory: CandidateDayHistory[];
  initialEvaluations: Evaluation[];
  initialTables: InterviewTable[];
  initialRooms: Room[];
  criteria: RubricCriterion[];
}) {
  const candidates = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const absenceHistory = useRealtimeRows<CandidateDayHistory>("candidate_day_history", initialAbsenceHistory, "recorded_at");
  const evaluations = useRealtimeRows<Evaluation>("evaluations", initialEvaluations);
  const tables = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const rooms = useRealtimeRows<Room>("rooms", initialRooms, "sort_order");
  const [view, setView] = useState<"candidates" | "tables">("candidates");
  const [query, setQuery] = useState("");
  const search = normalizeText(useDeferredValue(query));
  const [department, setDepartment] = useState<DepartmentCode | "">("");
  const [candidateStatus, setCandidateStatus] = useState<CandidateStatus | "">("");
  const [dayFilter, setDayFilter] = useState(() => {
    const today = todayInVietnam();
    const initialEvaluationByCandidate = new Map(initialEvaluations.map((evaluation) => [evaluation.candidate_id, evaluation]));
    return initialCandidates.some((candidate) => candidateApplicationDay(candidate, initialEvaluationByCandidate.get(candidate.id)) === today)
      || initialAbsenceHistory.some((item) => item.interview_day === today) ? today : "";
  });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  const candidateById = useMemo(() => new Map(candidates.rows.map((item) => [item.id, item])), [candidates.rows]);
  const evaluationByCandidate = useMemo(() => new Map(evaluations.rows.map((item) => [item.candidate_id, item])), [evaluations.rows]);
  const getApplicationStatus = useMemo(() => createCandidateApplicationStatusResolver(candidates.rows, evaluations.rows), [candidates.rows, evaluations.rows]);
  const historyByTable = useMemo(() => {
    const result = new Map<string, Evaluation[]>();
    for (const evaluation of evaluations.rows) {
      if (!evaluation.table_id) continue;
      const list = result.get(evaluation.table_id) ?? [];
      list.push(evaluation);
      result.set(evaluation.table_id, list);
    }
    for (const list of result.values()) list.sort((a, b) => (b.ended_at ?? b.created_at).localeCompare(a.ended_at ?? a.created_at));
    return result;
  }, [evaluations.rows]);
  const roomById = useMemo(() => new Map(rooms.rows.map((item) => [item.id, item])), [rooms.rows]);
  const availableDays = useMemo(() => [...new Set([
    ...candidates.rows.map((candidate) => candidateApplicationDay(candidate, evaluationByCandidate.get(candidate.id))).filter((day): day is string => !!day),
    ...absenceHistory.rows.map((item) => item.interview_day),
  ])].sort(), [candidates.rows, absenceHistory.rows, evaluationByCandidate]);

  const visibleCandidateRows = useMemo(() => {
    const liveRows = candidates.rows.filter((candidate) => {
      if (dayFilter && candidateApplicationDay(candidate, evaluationByCandidate.get(candidate.id)) !== dayFilter) return false;
      if (department && candidate.department !== department) return false;
      if (candidateStatus && getApplicationStatus(candidate) !== candidateStatus) return false;
      return !search || normalizeText(`${candidate.code} ${candidate.student_number ?? ""} ${candidate.full_name} ${candidate.phone ?? ""} ${candidate.email ?? ""}`).includes(search);
    }).map((candidate) => ({ key: candidate.id, candidate, history: null as CandidateDayHistory | null }));

    const historicalRows = absenceHistory.rows.filter((item) => {
      const liveCandidate = item.candidate_id ? candidateById.get(item.candidate_id) : undefined;
      if (liveCandidate && candidateApplicationDay(liveCandidate, evaluationByCandidate.get(liveCandidate.id)) === item.interview_day && getApplicationStatus(liveCandidate) !== "ABSENT") return false;
      if (dayFilter && item.interview_day !== dayFilter) return false;
      if (department && item.department !== department) return false;
      if (candidateStatus && item.status !== candidateStatus) return false;
      return !search || normalizeText(`${item.candidate_code} ${item.student_number ?? ""} ${item.full_name} ${item.phone ?? ""}`).includes(search);
    }).map((history) => ({
      key: `history-${history.id}`,
      candidate: history.candidate_id ? candidateById.get(history.candidate_id) : undefined,
      history,
    }));

    return [...liveRows, ...historicalRows].sort((a, b) =>
      (a.history?.candidate_code ?? a.candidate?.code ?? "").localeCompare(b.history?.candidate_code ?? b.candidate?.code ?? "", "vi", { numeric: true }) ||
      (a.history?.interview_day ?? "").localeCompare(b.history?.interview_day ?? ""),
    );
  }, [candidates.rows, absenceHistory.rows, candidateById, evaluationByCandidate, getApplicationStatus, dayFilter, department, candidateStatus, search]);

  const visibleRooms = useMemo(() => rooms.rows.map((room) => ({
    room,
    tables: tables.rows.filter((table) => table.room_id === room.id && (!department || table.department === department))
      .filter((table) => !search || normalizeText([
        room.name, table.name, table.department,
        ...(historyByTable.get(table.id) ?? []).map((evaluation) => {
          const candidate = candidateById.get(evaluation.candidate_id);
          return `${candidate?.full_name ?? ""} ${candidate?.code ?? ""}`;
        }),
      ].join(" ")).includes(search))
      .sort((a, b) => a.sort_order - b.sort_order),
  })).filter((item) => item.tables.length > 0).sort((a, b) => a.room.sort_order - b.room.sort_order || a.room.name.localeCompare(b.room.name)),
  [rooms.rows, tables.rows, department, search, historyByTable, candidateById]);

  const selectedCandidate = selectedCandidateId ? candidateById.get(selectedCandidateId) : undefined;
  const selectedEvaluation = selectedCandidate ? evaluationByCandidate.get(selectedCandidate.id) : undefined;
  const selectedTable = selectedTableId ? tables.rows.find((table) => table.id === selectedTableId) : undefined;
  const tableHistory = selectedTable ? historyByTable.get(selectedTable.id) ?? [] : [];
  const status = [candidates.status, absenceHistory.status, evaluations.status, tables.status, rooms.status].includes("offline") ? "offline"
    : [candidates.status, absenceHistory.status, evaluations.status, tables.status, rooms.status].every((item) => item === "live") ? "live" : "connecting";

  return <div className="min-h-dvh bg-muted/30">
    <AppHeader title="Tra cứu thí sinh & quản lý bàn" subtitle={staffName} status={status}>
      <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={role === "COORDINATOR" || role === "SUPPORT_IT" ? "/coordinator" : "/admin"}><ArrowLeft /> Quay lại</Link>
    </AppHeader>

    <main className="mx-auto max-w-screen-2xl space-y-5 px-4 py-5">
      <div className="flex flex-wrap gap-2 border-b pb-3">
        <Button variant={view === "candidates" ? "default" : "outline"} onClick={() => setView("candidates")}>
          <UserRound /> Tất cả thí sinh ({candidates.rows.length})
        </Button>
        <Button variant={view === "tables" ? "default" : "outline"} onClick={() => setView("tables")}>
          <DoorOpen /> Quản lý bàn ({tables.rows.length})
        </Button>
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9"
              placeholder={view === "candidates" ? "Tìm tên, mã, MSSV, SĐT, email…" : "Tìm phòng, bàn hoặc thí sinh đã phỏng vấn…"} />
          </div>
          {view === "candidates" && <select className="h-9 rounded-md border bg-background px-3 text-sm" value={candidateStatus}
            onChange={(event) => setCandidateStatus(event.target.value as CandidateStatus | "")} aria-label="Lọc trạng thái">
            <option value="">Mọi trạng thái</option>
            {(Object.keys(STATUS_LABEL) as CandidateStatus[]).map((item) => <option key={item} value={item}>{STATUS_LABEL[item]}</option>)}
          </select>}
          {view === "candidates" && <label className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <select className="h-9 rounded-md border bg-background pl-9 pr-3 text-sm" value={dayFilter}
              onChange={(event) => setDayFilter(event.target.value)} aria-label="Lọc theo ngày phỏng vấn">
              <option value="">Mọi ngày</option>
              {availableDays.map((day) => <option key={day} value={day}>{dayLabel(day)}</option>)}
            </select>
          </label>}
          {(query || department || (view === "candidates" && (candidateStatus || dayFilter))) && <Button type="button" variant="ghost" size="sm" className="shrink-0"
            onClick={() => { setQuery(""); setDepartment(""); setCandidateStatus(""); setDayFilter(""); }}>
            <RotateCcw /> Xóa bộ lọc
          </Button>}
        </div>
        <DepartmentRadio name="operations-department" value={department} onChange={setDepartment} allowAll />
        {view === "candidates" && <p className="text-xs text-muted-foreground" aria-live="polite">Đang hiển thị {visibleCandidateRows.length}/{candidates.rows.length + absenceHistory.rows.length} lượt phỏng vấn và lịch sử vắng</p>}
      </div>

      {view === "candidates" ? <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Mã</TableHead><TableHead>MSSV</TableHead><TableHead>Họ tên</TableHead><TableHead>SĐT</TableHead>
            <TableHead>Ban</TableHead><TableHead>Ca</TableHead><TableHead>Trạng thái</TableHead><TableHead>Ghi chú vắng</TableHead>
            <TableHead>Phòng - Bàn đã thi</TableHead><TableHead>Người bổ sung</TableHead>
            <TableHead className="text-right">Điểm TB</TableHead><TableHead className="text-right">Chi tiết</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {visibleCandidateRows.map(({ key, candidate, history }) => {
              const evaluation = candidate && !history ? evaluationByCandidate.get(candidate.id) : undefined;
              return <TableRow key={key} className={candidate && !history ? "cursor-pointer hover:bg-muted/40" : "bg-red-50/40 dark:bg-red-950/10"}
                onClick={candidate && !history ? () => setSelectedCandidateId(candidate.id) : undefined}>
                <TableCell className="font-mono text-xs">{history?.candidate_code ?? candidate?.code ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs">{history?.student_number ?? candidate?.student_number ?? "—"}</TableCell>
                <TableCell className="font-medium">{history?.full_name ?? candidate?.full_name ?? "Thí sinh đã xóa"}</TableCell>
                <TableCell>{history?.phone ?? candidate?.phone ?? "—"}</TableCell>
                <TableCell>{history?.department ?? candidate?.department ?? "—"}</TableCell>
                <TableCell>{history?.shift ?? (candidate ? candidateApplicationShift(candidate, evaluation) : null) ?? "—"}</TableCell>
                <TableCell><StatusBadge status={history?.status ?? (candidate ? getApplicationStatus(candidate) : "ABSENT")} /></TableCell>
                <TableCell className="max-w-64 whitespace-normal text-xs text-muted-foreground">{history?.absent_note ?? candidate?.absent_note ?? "—"}</TableCell>
                <TableCell>{evaluation?.table_label || (candidate?.table_id ? `${roomById.get(tables.rows.find((table) => table.id === candidate.table_id)?.room_id ?? "")?.name ?? ""} - ${tables.rows.find((table) => table.id === candidate.table_id)?.name ?? ""}` : "—")}</TableCell>
                <TableCell>{candidate?.added_by_name || "—"}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{evaluation?.average_score == null ? "—" : Number(evaluation.average_score).toFixed(2)}</TableCell>
                <TableCell className="text-right">{candidate && !history && <Button size="xs" variant="outline" onClick={(event) => { event.stopPropagation(); setSelectedCandidateId(candidate.id); }}>Xem</Button>}</TableCell>
              </TableRow>;
            })}
            {visibleCandidateRows.length === 0 && <TableRow><TableCell colSpan={12} className="py-12 text-center text-muted-foreground">Không tìm thấy thí sinh.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div> : <div className="space-y-5">
        {visibleRooms.map(({ room, tables: roomTables }) => <section key={room.id} className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-lg font-semibold">{room.name} <span className="text-sm font-normal text-muted-foreground">· {roomTables.length} bàn</span></h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {roomTables.map((table) => {
              const history = historyByTable.get(table.id) ?? [];
              const current = table.current_candidate_id ? candidateById.get(table.current_candidate_id) : undefined;
              return <button key={table.id} type="button" onClick={() => setSelectedTableId(table.id)}
                className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary">
                <div className="flex items-start justify-between gap-2">
                  <div><p className="font-semibold">{table.name}</p><p className="text-sm text-muted-foreground">Ban {table.department || "chưa chọn"}</p></div>
                  <span className={cn("rounded-full px-2 py-1 text-xs font-medium",
                    table.is_paused ? "bg-amber-100 text-amber-900" : table.status === "AVAILABLE" ? "bg-emerald-100 text-emerald-800" : table.status === "ASSIGNED" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800")}>{table.is_paused ? table.status === "AVAILABLE" ? "Tạm dừng tiếp nhận" : `${table.status === "ASSIGNED" ? "Chờ vào bàn" : "Đang phỏng vấn"} · Tạm dừng nhận mới` : table.status === "AVAILABLE" ? "Trống" : table.status === "ASSIGNED" ? "Chờ vào bàn" : "Đang phỏng vấn"}</span>
                </div>
                <p className="mt-4 text-sm">{current ? `Hiện tại: ${current.full_name}` : "Chưa có thí sinh tại bàn"}</p>
                <p className="mt-2 flex items-center gap-1 text-sm font-medium text-primary"><ClipboardList className="size-4" /> Đã phỏng vấn: {history.length} người</p>
              </button>;
            })}
          </div>
        </section>)}
        {visibleRooms.length === 0 && <p className="rounded-xl border bg-card p-12 text-center text-muted-foreground">Không tìm thấy phòng hoặc bàn phù hợp.</p>}
      </div>}
    </main>

    <Dialog open={!!selectedTableId} onOpenChange={(open) => { if (!open) setSelectedTableId(null); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        {selectedTable && <>
          <DialogHeader><DialogTitle>{roomById.get(selectedTable.room_id)?.name} - {selectedTable.name}</DialogTitle>
            <DialogDescription>Ban {DEPARTMENTS.find((item) => item.code === selectedTable.department)?.name ?? "chưa chọn"} · {tableHistory.length} thí sinh đã phỏng vấn</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {tableHistory.map((evaluation) => {
              const candidate = candidateById.get(evaluation.candidate_id);
              return <button key={evaluation.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-muted/40"
                onClick={() => { setSelectedTableId(null); setSelectedCandidateId(evaluation.candidate_id); }}>
                <span><span className="block font-medium">{candidate?.full_name ?? "Thí sinh đã xóa"}</span>
                  <span className="text-xs text-muted-foreground">{candidate?.code ?? "—"} · {formatDateTime(evaluation.ended_at)} · {evaluation.interviewer_name || "—"}</span></span>
                <span className="shrink-0 font-semibold tabular-nums">{evaluation.average_score == null ? "—" : Number(evaluation.average_score).toFixed(2)}/10</span>
              </button>;
            })}
            {tableHistory.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Bàn này chưa có phiếu phỏng vấn hoàn thành.</p>}
          </div>
        </>}
      </DialogContent>
    </Dialog>

    <Dialog open={!!selectedCandidateId} onOpenChange={(open) => { if (!open) setSelectedCandidateId(null); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        {selectedCandidate && <>
          <DialogHeader><DialogTitle>{selectedCandidate.full_name}</DialogTitle>
            <DialogDescription>{selectedCandidate.code} · {selectedCandidate.department || "Chưa có Ban"} · {candidateApplicationShift(selectedCandidate, selectedEvaluation) || "Chưa có ca"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <StatusBadge status={getApplicationStatus(selectedCandidate)} />
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">MSSV</dt><dd className="font-mono">{selectedCandidate.student_number || "—"}</dd>
              <dt className="text-muted-foreground">Khóa · Giới tính</dt><dd>{[selectedCandidate.student_cohort, selectedCandidate.gender === "NAM" ? "Nam" : selectedCandidate.gender === "NU" ? "Nữ" : selectedCandidate.gender === "KHAC" ? "Khác" : null].filter(Boolean).join(" · ") || "—"}</dd>
              <dt className="text-muted-foreground">Số điện thoại</dt><dd>{selectedCandidate.phone || "—"}</dd>
              <dt className="text-muted-foreground">Email</dt><dd className="break-all">{selectedCandidate.email || "—"}</dd>
              <dt className="text-muted-foreground">Facebook</dt><dd>{safeUrl(selectedCandidate.facebook_url) ? <a href={safeUrl(selectedCandidate.facebook_url)!} target="_blank" rel="noopener noreferrer" className="text-primary underline">Mở hồ sơ</a> : selectedCandidate.facebook_url || "—"}</dd>
              <dt className="text-muted-foreground">Check-in</dt><dd>{formatDateTime(selectedCandidate.checked_in_at) || "—"}</dd>
              <dt className="text-muted-foreground">Người bổ sung</dt><dd>{selectedCandidate.added_by_name || "—"}</dd>
              <dt className="text-muted-foreground">Phòng - Bàn</dt><dd>{selectedEvaluation?.table_label || "—"}</dd>
              <dt className="text-muted-foreground">Giám khảo đại diện</dt><dd>{selectedEvaluation?.interviewer_name || "—"}</dd>
              <dt className="text-muted-foreground">Bắt đầu</dt><dd>{formatDateTime(selectedEvaluation?.started_at ?? selectedCandidate.interview_started_at) || "—"}</dd>
              <dt className="text-muted-foreground">Kết thúc</dt><dd>{formatDateTime(selectedEvaluation?.ended_at ?? selectedCandidate.interview_ended_at) || "—"}</dd>
              <dt className="text-muted-foreground">Thời lượng</dt><dd>{formatDuration(selectedEvaluation?.duration_seconds ?? selectedCandidate.duration_seconds)}</dd>
            </dl>
            {safeUrl(selectedCandidate.cv_url) && <a href={safeUrl(selectedCandidate.cv_url)!} target="_blank" rel="noopener noreferrer" className="text-primary underline">Mở CV</a>}
            {selectedEvaluation ? <div className="space-y-3">
              <div className="divide-y rounded-lg border">
                {criteria.map((item) => <div key={item.id} className="flex justify-between gap-3 px-3 py-2"><span>{item.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{selectedEvaluation.scores?.[item.id] ?? "—"}/{item.max_score}</span></div>)}
                <div className="flex justify-between bg-muted/50 px-3 py-2 font-semibold"><span>Điểm TB</span><span>{selectedEvaluation.average_score == null ? "—" : Number(selectedEvaluation.average_score).toFixed(2)}/10</span></div>
              </div>
              <div><p className="mb-1 font-medium">Nhận xét</p><p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3">{selectedEvaluation.comment || "(Không có)"}</p></div>
            </div> : <p className="rounded-lg bg-muted/50 p-3 text-muted-foreground">Chưa có phiếu đánh giá.</p>}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
