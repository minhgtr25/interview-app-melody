"use client";

import { useEffect, useMemo, useRef, useState, useTransition, useDeferredValue } from "react";
import { toast } from "sonner";
import { Check, Search, Undo2, UserX, Loader2, Phone, Hash, Plus, Pencil, CalendarClock, RotateCcw, X } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { createClient } from "@/lib/supabase/client";
import { errorMessage, formatTime, normalizeText } from "@/lib/format";
import { STATUS_LABEL, type Candidate, type CandidateStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DepartmentRadio } from "@/components/department-radio";
import { type DepartmentCode } from "@/lib/departments";
import { GENDERS, type GenderCode, normalizeStudentNumber } from "@/lib/personal-info";
import { groupCandidateApplications } from "@/components/candidate-applications";
import { SPECIALIZATIONS_BY_DEPARTMENT, isSpecializedDepartment, specializationLabel, type SpecializationCode } from "@/lib/specializations";
import { dayLabel, interviewDate, todayInVietnam } from "@/lib/interview-days";
import { ScheduleRequestDialog } from "@/components/schedule-request-dialog";
import { useServerNow } from "@/components/clock";
import { useInterviewDayAutoSwitch } from "@/hooks/use-interview-day-auto-switch";
import { candidateApplicationDay, candidateApplicationShift } from "@/lib/candidate-application-day";

const NATIVE_SELECT =
  "h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type WalkInForm = { code: string; fullName: string; studentNumber: string; studentCohort: string; gender: GenderCode | ""; facebookUrl: string; department: DepartmentCode | ""; specialization: SpecializationCode | ""; phone: string; email: string };
const emptyWalkIn = (): WalkInForm => ({ code: "", fullName: "", studentNumber: "", studentCohort: "", gender: "", facebookUrl: "", department: "", specialization: "", phone: "", email: "" });

function haptic() {
  try {
    navigator.vibrate?.(30);
  } catch {
    /* thiết bị không hỗ trợ */
  }
}

export function CheckinBoard({
  initialCandidates,
  activeDay,
  staffName,
}: {
  initialCandidates: Candidate[];
  activeDay?: string;
  staffName: string;
}) {
  const { rows, setRows, patchRow, status, refetch } = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const serverNow = useServerNow(30_000);
  useInterviewDayAutoSwitch(activeDay);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [shift, setShift] = useState("");
  const today = todayInVietnam(serverNow);
  const previousDay = useRef(today);
  const [day, setDay] = useState(() => initialCandidates.some((candidate) => candidateApplicationDay(candidate) === today) ? today : "");
  const [dept, setDept] = useState<DepartmentCode | "">("");
  const [statusFilter, setStatusFilter] = useState<"" | CandidateStatus>("");
  const [absenceManager, setAbsenceManager] = useState(false);
  const [scheduleCandidate, setScheduleCandidate] = useState<Candidate | null>(null);
  const [absenceCandidate, setAbsenceCandidate] = useState<Candidate | null>(null);
  const [absenceNote, setAbsenceNote] = useState("");
  const [absenceDialogMode, setAbsenceDialogMode] = useState<"MARK" | "EDIT">("MARK");
  const [savingAbsence, setSavingAbsence] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkIn, setWalkIn] = useState<WalkInForm>(emptyWalkIn);
  const [addingWalkIn, setAddingWalkIn] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (today === previousDay.current) return;
    const previous = previousDay.current;
    setDay((selected) => selected === previous ? today : selected);
    setShift("");
    previousDay.current = today;
  }, [today]);

  const days = useMemo(() => [...new Set(rows.map((row) => candidateApplicationDay(row)).filter((value): value is string => !!value))].sort(), [rows]);
  const shifts = useMemo(
    () => [...new Set(rows.filter((row) => !day || candidateApplicationDay(row) === day).map((row) => candidateApplicationShift(row)).filter(Boolean) as string[])].sort(),
    [rows, day]
  );

  const groupByCandidate = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupCandidateApplications>[number]>();
    for (const group of groupCandidateApplications(rows)) {
      for (const application of group.applications) map.set(application.id, group);
    }
    return map;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = normalizeText(deferredQuery);
    const qDigits = deferredQuery.replace(/\D/g, "");
    return rows
      .filter((c) => {
        if (absenceManager && c.status !== "ABSENT") return false;
        const candidateDay = candidateApplicationDay(c);
        const earlyArrival = day === today && !!candidateDay && candidateDay > today && c.status === "NOT_ARRIVED";
        if (day && candidateDay !== day && (candidateDay || c.status === "COMPLETED") && !earlyArrival) return false;
        if (shift && candidateApplicationShift(c) !== shift) return false;
        if (dept && c.department !== dept) return false;
        if (statusFilter && c.status !== statusFilter) return false;
        if (!q) return true;
        return (
          normalizeText(c.full_name).includes(q) ||
          normalizeText(c.code).includes(q) ||
          normalizeText(c.student_number ?? groupByCandidate.get(c.id)?.primary.student_number ?? "").includes(q) ||
          (qDigits.length >= 3 && (c.phone ?? "").replace(/\D/g, "").includes(qDigits))
        );
      })
      .sort((a, b) => {
        if (absenceManager) return (b.absent_at ?? "").localeCompare(a.absent_at ?? "");
        // Chưa đến lên đầu để tiếp đón nhanh, sau đó theo mã
        const pa = a.status === "NOT_ARRIVED" ? 0 : 1;
        const pb = b.status === "NOT_ARRIVED" ? 0 : 1;
        return pa - pb || a.code.localeCompare(b.code, "vi", { numeric: true });
      });
  }, [rows, deferredQuery, shift, dept, statusFilter, absenceManager, day, groupByCandidate, today]);

  const counts = useMemo(() => {
    const scoped = rows.filter((row) => !day || candidateApplicationDay(row) === day || (!candidateApplicationDay(row) && row.status !== "COMPLETED"));
    const total = scoped.length;
    const arrived = scoped.filter((r) => r.status !== "NOT_ARRIVED" && r.status !== "ABSENT").length;
    const absent = scoped.filter((r) => r.status === "ABSENT").length;
    return { total, arrived, absent };
  }, [rows, day]);

  async function run(c: Candidate, fn: string, optimistic: Partial<Candidate>, okMsg: string) {
    setBusyId(c.id);
    const before = { status: c.status, checked_in_at: c.checked_in_at, absent_at: c.absent_at, absent_note: c.absent_note, shift: c.shift, interview_note: c.interview_note };
    patchRow(c.id, optimistic);
    const { error } = await createClient().rpc(fn, { p_candidate_id: c.id });
    setBusyId(null);
    if (error) {
      patchRow(c.id, before);
      toast.error(errorMessage(error));
      return;
    }
    if (fn === "check_in_candidate") {
      haptic();
      setFlashId(c.id);
      startTransition(() => {
        setTimeout(() => setFlashId((id) => (id === c.id ? null : id)), 1500);
      });
    }
    toast.success(okMsg);
  }

  const checkIn = async (c: Candidate) => {
    const today = todayInVietnam(serverNow);
    const scheduledDay = interviewDate(c);
    const early = !!scheduledDay && scheduledDay > today;
    if (scheduledDay && scheduledDay < today) {
      toast.error("Ca không thuộc ngày hôm nay. Gửi yêu cầu đổi lịch trước khi check-in.");
      return;
    }
    if (early && !window.confirm(`Xác nhận phỏng vấn sớm hôm nay? Ca ${c.shift} sẽ chuyển sang hôm nay và lưu lịch ban đầu.`)) return;

    await run(
      c,
      "check_in_candidate",
      { status: "CHECKED_IN", checked_in_at: new Date().toISOString(), absent_at: null, absent_note: null,
        ...(early ? { shift: `${dayLabel(today)}${c.shift?.slice(10) ?? ""}` } : {}) },
      `Đã check-in: ${c.full_name}`
    );
    if (early) await refetch();
  };
  const undo = (c: Candidate) =>
    run(c, "undo_check_in", { status: "NOT_ARRIVED", checked_in_at: null }, `Đã hoàn tác: ${c.full_name}`);
  function openAbsenceNote(c: Candidate) {
    setAbsenceDialogMode("MARK");
    setAbsenceCandidate(c);
    setAbsenceNote(c.absent_note ?? "");
  }

  function openEditAbsenceNote(c: Candidate) {
    setAbsenceDialogMode("EDIT");
    setAbsenceCandidate(c);
    setAbsenceNote(c.absent_note ?? "");
  }

  async function saveAbsence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!absenceCandidate || savingAbsence) return;
    const candidate = absenceCandidate;
    setSavingAbsence(true);
    setBusyId(candidate.id);
    const note = absenceNote.trim().slice(0, 2000);
    const { error } = absenceDialogMode === "EDIT"
      ? await createClient().rpc("update_absent_note", {
          p_candidate_id: candidate.id,
          p_note: note || null,
        })
      : await createClient().rpc("mark_absent_with_note", {
          p_candidate_id: candidate.id,
          p_note: note || null,
        });
    setSavingAbsence(false);
    setBusyId(null);
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    if (absenceDialogMode === "EDIT") {
      patchRow(candidate.id, { absent_note: note || null });
      toast.success(`Đã cập nhật ghi chú: ${candidate.full_name}`);
    } else {
      await refetch();
      toast.success(`Đã đánh vắng: ${candidate.full_name}`);
    }
    setAbsenceCandidate(null);
    setAbsenceNote("");
  }

  async function addWalkIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addingWalkIn) return;
    if (!walkIn.code.trim() || !walkIn.fullName.trim() || !walkIn.department || !walkIn.gender || !normalizeStudentNumber(walkIn.studentNumber) ||
      (isSpecializedDepartment(walkIn.department) && !walkIn.specialization)) {
      toast.error("Nhập mã ứng viên, MSSV 8 ký tự, họ tên, Giới tính và Ban");
      return;
    }
    setAddingWalkIn(true);
    const { data, error } = await createClient().rpc("add_walk_in_candidate", {
      p_code: walkIn.code.trim(),
      p_full_name: walkIn.fullName.trim(),
      p_department: walkIn.department,
      p_phone: walkIn.phone.trim() || null,
      p_email: walkIn.email.trim() || null,
      p_shift: null,
      p_student_number: normalizeStudentNumber(walkIn.studentNumber),
      p_student_cohort: walkIn.studentCohort.trim() || null,
      p_gender: walkIn.gender,
      p_facebook_url: walkIn.facebookUrl.trim() || null,
      p_specialization: walkIn.specialization || null,
    });
    setAddingWalkIn(false);
    if (error) {
      toast.error(error.code === "23505" ? error.message?.includes("student_number")
        ? `MSSV "${walkIn.studentNumber.trim()}" đã thuộc thí sinh khác`
        : `Mã ứng viên "${walkIn.code.trim()}" đã tồn tại`
          : errorMessage(error));
      return;
    }
    const candidate = (Array.isArray(data) ? data[0] : data) as Candidate | null;
    if (!candidate?.id) {
      toast.error("Đã gửi yêu cầu nhưng không nhận được thông tin thí sinh. Hãy tải lại danh sách.");
      return;
    }
    setRows((current) => current.some((item) => item.id === candidate.id) ? current : [...current, candidate]);
    setQuery(""); setShift(""); setDept(""); setStatusFilter("");
    setFlashId(candidate.id);
    window.setTimeout(() => setFlashId((id) => id === candidate.id ? null : id), 1500);
    haptic();
    toast.success(`Đã thêm và check-in: ${candidate.full_name}`);
    setWalkIn(emptyWalkIn());
    setWalkInOpen(false);
  }

  function Actions({ c, size = "default" }: { c: Candidate; size?: "default" | "lg" }) {
    const busy = busyId === c.id;
    if (c.challenge_status) return <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">{c.challenge_status === "COMPLETED" ? "Đã xong thử thách" : c.challenge_status === "INTERVIEWING" ? "Đang thử thách" : "Đang chờ thử thách"}</span>;
    if (c.status === "NOT_ARRIVED" || c.status === "ABSENT") {
      return (
        <Button
          onClick={() => checkIn(c)}
          disabled={busy}
          className={cn(
            "bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.97]",
            size === "lg" ? "h-12 w-full text-base" : "h-9 px-4"
          )}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
          {interviewDate(c) && interviewDate(c)! > today ? "Điểm danh sớm" : c.status === "ABSENT" ? "Check-in lại" : "Điểm danh"}
        </Button>
      );
    }
    if (c.status === "CHECKED_IN") {
      return (
        <div className={cn("flex gap-2", size === "lg" && "w-full")}>
          <Button
            variant="outline"
            onClick={() => undo(c)}
            disabled={busy}
            className={size === "lg" ? "h-11 flex-1" : "h-9"}
          >
            <Undo2 /> Hoàn tác
          </Button>
        </div>
      );
    }
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader title="Bàn tiếp đón · Check-in" mobileTitle="Check-in" subtitle={staffName} status={status}>
        <span className="hidden rounded-full bg-muted px-3 py-1 text-xs font-medium tabular-nums lg:inline">
          Đã đến {counts.arrived}/{counts.total}
        </span>
      </AppHeader>

      {/* Thanh tìm kiếm + lọc: sticky dưới header */}
      <div className="sticky top-14 z-20 border-b bg-background/95 shadow-sm backdrop-blur">
        <div className="mx-auto max-w-screen-2xl space-y-2 px-3 py-3 sm:px-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-[minmax(240px,1.6fr)_minmax(150px,0.9fr)_minmax(180px,1.1fr)_minmax(160px,1fr)_auto]">
            <div className="relative col-span-2 min-w-0 lg:col-span-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm tên, MSSV, SĐT hoặc mã ứng viên…"
                className="h-10 pl-9 pr-9 text-sm"
                type="search"
                enterKeyHint="search"
              />
              {query && <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-1/2 -translate-y-1/2"
                aria-label="Xóa nội dung tìm kiếm" onClick={() => setQuery("")}><X /></Button>}
            </div>
            <select className={cn(NATIVE_SELECT, "w-full min-w-0")} value={day} onChange={(event) => { setDay(event.target.value); setShift(""); }} aria-label="Lọc ngày phỏng vấn">
              <option value="">Mọi ngày</option>
              {days.map((value) => <option key={value} value={value}>{dayLabel(value)}</option>)}
            </select>
            <select className={cn(NATIVE_SELECT, "w-full min-w-0")} value={shift} onChange={(e) => setShift(e.target.value)} aria-label="Lọc theo ca">
              <option value="">Tất cả ca</option>
              {shifts.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {!absenceManager && <select
              className={cn(NATIVE_SELECT, "w-full min-w-0")}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as CandidateStatus | "")}
              aria-label="Lọc theo trạng thái"
            >
              <option value="">Mọi trạng thái</option>
              {(Object.keys(STATUS_LABEL) as CandidateStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>}
            {(query || day || shift || dept || statusFilter) && <Button type="button" variant="ghost" size="sm" className="justify-self-start lg:justify-self-end"
              onClick={() => { setQuery(""); setDay(""); setShift(""); setDept(""); setStatusFilter(""); }}>
              <RotateCcw /> Xóa bộ lọc
            </Button>}
          </div>
          <div className="min-w-0">
            <DepartmentRadio name="checkin-department" value={dept} onChange={setDept} allowAll />
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-screen-2xl px-3 py-4 sm:px-4">
        <div className="mb-3 grid grid-cols-2 gap-2 sm:flex">
          <Button variant={absenceManager ? "outline" : "default"} className="w-full sm:w-auto" onClick={() => { setAbsenceManager(false); setStatusFilter(""); }}>
            Danh sách check-in
          </Button>
          <Button variant={absenceManager ? "default" : "outline"} className="w-full sm:w-auto" onClick={() => { setAbsenceManager(true); setStatusFilter(""); setDay(""); setShift(""); }}>
            Quản lý vắng mặt ({counts.absent})
          </Button>
        </div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{filtered.length} {absenceManager ? "trường hợp vắng mặt" : `thí sinh · Đã đến ${counts.arrived}/${counts.total}`}</p>
          <Button className="w-full sm:w-auto" onClick={() => setWalkInOpen(true)}><Plus /> Thêm thí sinh bổ sung</Button>
        </div>

        {/* Large screens: table; mobile and iPad: responsive cards */}
        <div className="hidden overflow-x-auto rounded-xl border bg-card xl:block">
          <Table className="min-w-[1024px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Mã</TableHead>
                <TableHead>MSSV</TableHead>
                <TableHead>Họ tên</TableHead>
                <TableHead>SĐT</TableHead>
                <TableHead>Ban</TableHead>
                <TableHead>Ca</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Ghi chú vắng</TableHead>
                <TableHead className="w-56 text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow
                  key={c.id}
                  className={cn("transition-colors", flashId === c.id && "bg-emerald-50 dark:bg-emerald-950")}
                >
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell className="font-mono text-xs">{c.student_number || groupByCandidate.get(c.id)?.primary.student_number || "—"}</TableCell>
                  <TableCell className="font-medium">{c.full_name}</TableCell>
                  <TableCell className="tabular-nums">{c.phone}</TableCell>
                  <TableCell>{c.department}{c.specialization && <span className="block text-xs text-muted-foreground">{specializationLabel(c.specialization)}</span>}</TableCell>
                  <TableCell>{candidateApplicationShift(c) || "—"}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      {c.checked_in_at && c.status !== "NOT_ARRIVED" && (
                        <span className="text-xs text-muted-foreground">{formatTime(c.checked_in_at)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal text-sm">
                    {c.status === "ABSENT" ? (
                      <div className="flex items-start justify-between gap-2">
                        <span className="whitespace-pre-wrap">{c.absent_note || "Chưa có ghi chú"}</span>
                        {absenceManager && (
                          <Button variant="ghost" size="icon" className="-mt-1 size-8 shrink-0"
                            onClick={() => openEditAbsenceNote(c)} disabled={busyId === c.id}
                            aria-label="Sửa ghi chú vắng mặt" title="Sửa ghi chú vắng mặt">
                            <Pencil />
                          </Button>
                        )}
                      </div>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Actions c={c} />
                      {absenceManager && c.status === "ABSENT" && <Button variant="outline" size="sm" onClick={() => setScheduleCandidate(c)}>
                        <CalendarClock /> Đổi lịch
                      </Button>}
                      {c.status === "NOT_ARRIVED" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openAbsenceNote(c)}
                          disabled={busyId === c.id}
                          aria-label="Đánh vắng"
                          title="Đánh vắng"
                        >
                          <UserX />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    Không tìm thấy thí sinh phù hợp.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Cards fit phones and tablet screens without horizontal scrolling */}
        <ul className="grid gap-3 md:grid-cols-2 xl:hidden">
          {filtered.map((c) => (
            <li
              key={c.id}
              className={cn(
                "rounded-xl border bg-card p-4 shadow-xs transition-all",
                flashId === c.id && "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/40 dark:bg-emerald-950"
              )}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-base font-semibold">{c.full_name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-mono"><Hash className="size-3" />{c.code}</span>
                    {(c.student_number || groupByCandidate.get(c.id)?.primary.student_number) && <span className="font-mono">MSSV {c.student_number || groupByCandidate.get(c.id)?.primary.student_number}</span>}
                    {c.phone && (
                      <span className="inline-flex items-center gap-1 tabular-nums"><Phone className="size-3" />{c.phone}</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[c.department, specializationLabel(c.specialization), candidateApplicationShift(c)].filter(Boolean).join(" · ")}
                  </p>
                  {c.interview_note && <p className="mt-1 text-xs font-medium text-amber-700">{c.interview_note}</p>}
                  {c.status === "ABSENT" && <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">Ghi chú vắng mặt</p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{c.absent_note || "Chưa có ghi chú"}</p>
                    {c.absent_at && <time className="mt-2 block text-xs text-muted-foreground">Ghi nhận lúc {formatTime(c.absent_at)}</time>}
                    {absenceManager && <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditAbsenceNote(c)} disabled={busyId === c.id}>
                        <Pencil /> Sửa ghi chú
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setScheduleCandidate(c)}>
                        <CalendarClock /> Yêu cầu đổi lịch
                      </Button>
                    </div>}
                  </div>}
                </div>
                <StatusBadge status={c.status} />
              </div>
              {c.status === "NOT_ARRIVED" ? <div className="flex w-full gap-2">
                <div className="min-w-0 flex-1"><Actions c={c} size="lg" /></div>
                <Button variant="outline" className="h-12 shrink-0 px-3 text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                  onClick={() => openAbsenceNote(c)} disabled={busyId === c.id} aria-label="Đánh vắng" title="Đánh vắng">
                  {busyId === c.id ? <Loader2 className="animate-spin" /> : <UserX />}
                  <span className="hidden sm:inline">Vắng</span>
                </Button>
              </div> : <Actions c={c} size="lg" />}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="py-10 text-center text-sm text-muted-foreground">Không tìm thấy thí sinh phù hợp.</li>
          )}
        </ul>
      </main>
      <ScheduleRequestDialog candidate={scheduleCandidate} candidates={rows} onClose={() => setScheduleCandidate(null)} />

      <Dialog open={walkInOpen} onOpenChange={(open) => { if (!addingWalkIn) setWalkInOpen(open); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl md:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Thêm thí sinh tại bàn Check-in</DialogTitle>
            <DialogDescription>Thí sinh được check-in ngay và chuyển vào hàng chờ Điều phối. Hệ thống tự lưu tài khoản đã thêm để Admin kiểm tra.</DialogDescription>
          </DialogHeader>
          <form onSubmit={addWalkIn} className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-code">Mã ứng viên *</Label>
                <Input id="walkin-code" value={walkIn.code} maxLength={64} required disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, code: event.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-name">Họ tên *</Label>
                <Input id="walkin-name" value={walkIn.fullName} maxLength={200} required disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, fullName: event.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-student-number">MSSV *</Label>
                <Input id="walkin-student-number" value={walkIn.studentNumber} maxLength={8} required disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, studentNumber: event.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-cohort">Khóa sinh viên</Label>
                <Input id="walkin-cohort" value={walkIn.studentCohort} maxLength={32} disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, studentCohort: event.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-gender">Giới tính *</Label>
                <select id="walkin-gender" className={NATIVE_SELECT} value={walkIn.gender} required disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, gender: event.target.value as GenderCode | "" })}>
                  <option value="">Chọn giới tính</option>
                  {GENDERS.map((gender) => <option key={gender.code} value={gender.code}>{gender.name}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-phone">Số điện thoại</Label>
                <Input id="walkin-phone" type="tel" value={walkIn.phone} maxLength={32} disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, phone: event.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="walkin-email">Email</Label>
                <Input id="walkin-email" type="email" value={walkIn.email} maxLength={200} disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, email: event.target.value })} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="walkin-facebook">Link Facebook</Label>
                <Input id="walkin-facebook" value={walkIn.facebookUrl} maxLength={2000} disabled={addingWalkIn}
                  onChange={(event) => setWalkIn({ ...walkIn, facebookUrl: event.target.value })} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Ban ứng tuyển *</Label>
              <DepartmentRadio name="walkin-department" value={walkIn.department}
                onChange={(department) => setWalkIn({ ...walkIn, department, specialization: "" })} disabled={addingWalkIn} />
            </div>
            {isSpecializedDepartment(walkIn.department) && <div className="grid gap-1.5">
              <Label htmlFor="walkin-specialization">Ngạch *</Label>
              <select id="walkin-specialization" className={NATIVE_SELECT} required value={walkIn.specialization} disabled={addingWalkIn}
                onChange={(event) => setWalkIn({ ...walkIn, specialization: event.target.value as SpecializationCode | "" })}>
                <option value="">Chọn ngạch</option>
                {(walkIn.department === "CM" ? SPECIALIZATIONS_BY_DEPARTMENT.CM : SPECIALIZATIONS_BY_DEPARTMENT.TT).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
            </div>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={addingWalkIn} onClick={() => setWalkInOpen(false)}>Hủy</Button>
              <Button type="submit" disabled={addingWalkIn}>{addingWalkIn && <Loader2 className="animate-spin" />} Thêm và check-in</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={absenceCandidate !== null} onOpenChange={(open) => {
        if (!savingAbsence && !open) { setAbsenceCandidate(null); setAbsenceNote(""); }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{absenceDialogMode === "EDIT" ? "Sửa ghi chú vắng" : "Đánh vắng"} · {absenceCandidate?.full_name}</DialogTitle>
            <DialogDescription>{absenceDialogMode === "EDIT"
              ? "Cập nhật ghi chú cho trường hợp đã vắng. Trạng thái và thời điểm báo vắng được giữ nguyên."
              : "Ghi lại lý do hoặc thông tin liên hệ để đội Check-in và Điều phối theo dõi."}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveAbsence} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="absence-note">Ghi chú</Label>
              <Textarea id="absence-note" value={absenceNote} maxLength={2000} disabled={savingAbsence}
                onChange={(event) => setAbsenceNote(event.target.value)}
                placeholder="Ví dụ: xin chuyển ca chiều; đã gọi nhưng chưa liên lạc được…"
                className="min-h-28 resize-y" />
              <p className="text-right text-xs text-muted-foreground">{absenceNote.length}/2000</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={savingAbsence} onClick={() => setAbsenceCandidate(null)}>Hủy</Button>
              <Button type="submit" variant={absenceDialogMode === "EDIT" ? "default" : "destructive"} disabled={savingAbsence}>
                {savingAbsence && <Loader2 className="animate-spin" />} {absenceDialogMode === "EDIT" ? "Lưu ghi chú" : "Xác nhận vắng mặt"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
