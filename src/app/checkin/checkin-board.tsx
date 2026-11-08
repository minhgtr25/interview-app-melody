"use client";

import { useMemo, useState, useTransition, useDeferredValue } from "react";
import { toast } from "sonner";
import { Check, Search, Undo2, UserX, Loader2, Phone, Hash, Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const NATIVE_SELECT =
  "h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type WalkInForm = { code: string; fullName: string; studentNumber: string; studentCohort: string; gender: GenderCode | ""; facebookUrl: string; department: DepartmentCode | ""; phone: string; email: string };
const emptyWalkIn = (): WalkInForm => ({ code: "", fullName: "", studentNumber: "", studentCohort: "", gender: "", facebookUrl: "", department: "", phone: "", email: "" });

function haptic() {
  try {
    navigator.vibrate?.(30);
  } catch {
    /* thiết bị không hỗ trợ */
  }
}

export function CheckinBoard({
  initialCandidates,
  staffName,
}: {
  initialCandidates: Candidate[];
  staffName: string;
}) {
  const { rows, setRows, patchRow, status } = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [shift, setShift] = useState("");
  const [dept, setDept] = useState<DepartmentCode | "">("");
  const [statusFilter, setStatusFilter] = useState<"" | CandidateStatus>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkIn, setWalkIn] = useState<WalkInForm>(emptyWalkIn);
  const [addingWalkIn, setAddingWalkIn] = useState(false);
  const [, startTransition] = useTransition();

  const shifts = useMemo(
    () => [...new Set(rows.map((r) => r.shift).filter(Boolean) as string[])].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = normalizeText(deferredQuery);
    const qDigits = deferredQuery.replace(/\D/g, "");
    return rows
      .filter((c) => {
        if (shift && c.shift !== shift) return false;
        if (dept && c.department !== dept) return false;
        if (statusFilter && c.status !== statusFilter) return false;
        if (!q) return true;
        return (
          normalizeText(c.full_name).includes(q) ||
          normalizeText(c.code).includes(q) ||
          normalizeText(c.student_number ?? "").includes(q) ||
          (qDigits.length >= 3 && (c.phone ?? "").replace(/\D/g, "").includes(qDigits))
        );
      })
      .sort((a, b) => {
        // Chưa đến lên đầu để tiếp đón nhanh, sau đó theo mã
        const pa = a.status === "NOT_ARRIVED" ? 0 : 1;
        const pb = b.status === "NOT_ARRIVED" ? 0 : 1;
        return pa - pb || a.code.localeCompare(b.code, "vi", { numeric: true });
      });
  }, [rows, deferredQuery, shift, dept, statusFilter]);

  const counts = useMemo(() => {
    const total = rows.length;
    const arrived = rows.filter((r) => r.status !== "NOT_ARRIVED" && r.status !== "ABSENT").length;
    return { total, arrived };
  }, [rows]);

  async function run(c: Candidate, fn: string, optimistic: Partial<Candidate>, okMsg: string) {
    setBusyId(c.id);
    const before = { status: c.status, checked_in_at: c.checked_in_at, absent_at: c.absent_at };
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

  const checkIn = (c: Candidate) =>
    run(
      c,
      "check_in_candidate",
      { status: "CHECKED_IN", checked_in_at: new Date().toISOString(), absent_at: null },
      `Đã check-in: ${c.full_name}`
    );
  const undo = (c: Candidate) =>
    run(c, "undo_check_in", { status: "NOT_ARRIVED", checked_in_at: null }, `Đã hoàn tác: ${c.full_name}`);
  const absent = (c: Candidate) =>
    run(c, "mark_absent", { status: "ABSENT", absent_at: new Date().toISOString() }, `Đã đánh vắng: ${c.full_name}`);

  async function addWalkIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addingWalkIn) return;
    if (!walkIn.code.trim() || !walkIn.fullName.trim() || !walkIn.department || !walkIn.gender || !normalizeStudentNumber(walkIn.studentNumber)) {
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
    });
    setAddingWalkIn(false);
    if (error) {
      toast.error(error.code === "23505" ? error.message?.includes("student_number")
        ? `MSSV "${walkIn.studentNumber.trim()}" đã thuộc thí sinh khác`
        : `Mã ứng viên "${walkIn.code.trim()}" đã tồn tại`
          : error.code === "PGRST202" || error.code === "42703"
          ? "Database chưa cập nhật hồ sơ thí sinh. Admin cần chạy migration 20261108_candidate_personal_fields.sql."
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
          {c.status === "ABSENT" ? "Check-in lại" : "Điểm danh"}
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
      <AppHeader title="Bàn tiếp đón · Check-in" subtitle={staffName} status={status}>
        <span className="hidden rounded-full bg-muted px-3 py-1 text-xs font-medium tabular-nums md:inline">
          Đã đến {counts.arrived}/{counts.total}
        </span>
      </AppHeader>

      {/* Thanh tìm kiếm + lọc: sticky dưới header */}
      <div className="sticky top-14 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-2 px-4 py-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tên, MSSV, SĐT hoặc mã ứng viên…"
              className="h-11 pl-9 text-base md:h-10 md:text-sm"
              type="search"
              enterKeyHint="search"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-3 gap-2 md:flex">
            <select className={NATIVE_SELECT} value={shift} onChange={(e) => setShift(e.target.value)} aria-label="Lọc theo ca">
              <option value="">Tất cả ca</option>
              {shifts.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div className="col-span-3"><DepartmentRadio name="checkin-department" value={dept} onChange={setDept} allowAll /></div>
            <select
              className={NATIVE_SELECT}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as CandidateStatus | "")}
              aria-label="Lọc theo trạng thái"
            >
              <option value="">Mọi trạng thái</option>
              {(Object.keys(STATUS_LABEL) as CandidateStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-screen-2xl px-4 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{filtered.length} thí sinh</p>
          <Button onClick={() => setWalkInOpen(true)}><Plus /> Thêm thí sinh bổ sung</Button>
        </div>

        {/* Desktop: bảng */}
        <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Mã</TableHead>
                <TableHead>MSSV</TableHead>
                <TableHead>Họ tên</TableHead>
                <TableHead>SĐT</TableHead>
                <TableHead>Ban</TableHead>
                <TableHead>Ca</TableHead>
                <TableHead>Trạng thái</TableHead>
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
                  <TableCell className="font-mono text-xs">{c.student_number || "—"}</TableCell>
                  <TableCell className="font-medium">{c.full_name}</TableCell>
                  <TableCell className="tabular-nums">{c.phone}</TableCell>
                  <TableCell>{c.department}</TableCell>
                  <TableCell>{c.shift}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      {c.checked_in_at && c.status !== "NOT_ARRIVED" && (
                        <span className="text-xs text-muted-foreground">{formatTime(c.checked_in_at)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Actions c={c} />
                      {c.status === "NOT_ARRIVED" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => absent(c)}
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
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    Không tìm thấy thí sinh phù hợp.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Mobile: thẻ */}
        <ul className="grid gap-3 md:hidden">
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
                  <p className="truncate text-base font-semibold">{c.full_name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-mono"><Hash className="size-3" />{c.code}</span>
                    {c.student_number && <span className="font-mono">MSSV {c.student_number}</span>}
                    {c.phone && (
                      <span className="inline-flex items-center gap-1 tabular-nums"><Phone className="size-3" />{c.phone}</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[c.department, c.shift].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <StatusBadge status={c.status} />
              </div>
              <Actions c={c} size="lg" />
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="py-10 text-center text-sm text-muted-foreground">Không tìm thấy thí sinh phù hợp.</li>
          )}
        </ul>
      </main>

      <Dialog open={walkInOpen} onOpenChange={(open) => { if (!addingWalkIn) setWalkInOpen(open); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
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
                onChange={(department) => setWalkIn({ ...walkIn, department })} disabled={addingWalkIn} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={addingWalkIn} onClick={() => setWalkInOpen(false)}>Hủy</Button>
              <Button type="submit" disabled={addingWalkIn}>{addingWalkIn && <Loader2 className="animate-spin" />} Thêm và check-in</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
