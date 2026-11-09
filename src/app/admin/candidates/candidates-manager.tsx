"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Pencil, Plus, RotateCcw, Search, Trash2, Eye, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/status-badge";
import { LiveIndicator } from "@/components/app-header";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { createClient } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/fetch-all";
import { exportResults } from "@/lib/excel";
import { errorMessage, formatDateTime, formatDuration, normalizeText, safeUrl } from "@/lib/format";
import { ROLE_LABEL, STATUS_LABEL, type Candidate, type CandidateStatus, type Evaluation, type RubricCriterion } from "@/lib/types";
import { deleteAllCandidates, deleteCandidate, saveCandidate, type CandidateInput } from "../actions";
import { ImportDialog } from "./import-dialog";
import { DepartmentRadio } from "@/components/department-radio";
import { type DepartmentCode, isDepartmentCode } from "@/lib/departments";
import { DEPARTMENTS } from "@/lib/departments";
import { GENDERS } from "@/lib/personal-info";
import { groupCandidateApplications } from "@/components/candidate-applications";

const SELECT_CLS = "h-9 rounded-lg border border-input bg-background px-3 text-sm";
const EMPTY: CandidateInput = { code: "", full_name: "", student_number: "", student_cohort: "", gender: "", facebook_url: "", phone: "", email: "", department: "", shift: "", cv_url: "" };

type Confirm =
  | { kind: "reset" | "delete"; c: Candidate }
  | { kind: "deleteAll" }
  | null;

export function CandidatesManager({
  initialCandidates,
  initialEvaluations,
}: {
  initialCandidates: Candidate[];
  initialEvaluations: Evaluation[];
}) {
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const evals = useRealtimeRows<Evaluation>("evaluations", initialEvaluations);
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const [statusF, setStatusF] = useState<"" | CandidateStatus>("");
  const [deptF, setDeptF] = useState<DepartmentCode | "">("");
  const [exportDept, setExportDept] = useState<DepartmentCode>("CM");
  const [sourceF, setSourceF] = useState<"" | "CHECKIN">("");
  const [editing, setEditing] = useState<{ id: string | null; data: CandidateInput } | null>(null);
  const [viewing, setViewing] = useState<Candidate | null>(null);
  const [criteria, setCriteria] = useState<RubricCriterion[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const evalBy = useMemo(() => new Map(evals.rows.map((e) => [e.candidate_id, e])), [evals.rows]);
  const groupByCandidate = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupCandidateApplications>[number]>();
    for (const group of groupCandidateApplications(cand.rows)) {
      for (const application of group.applications) map.set(application.id, group);
    }
    return map;
  }, [cand.rows]);

  const filtered = useMemo(() => {
    const nq = normalizeText(q);
    return cand.rows
      .filter((c) => (!statusF || c.status === statusF) && (!deptF || c.department === deptF) && (!sourceF || c.added_by_role === sourceF))
      .filter((c) => !nq || normalizeText(`${c.code} ${c.student_number ?? ""} ${c.student_number_raw ?? ""} ${c.full_name} ${c.phone ?? ""} ${c.email ?? ""}`).includes(nq))
      .sort((a, b) => a.code.localeCompare(b.code, "vi", { numeric: true }));
  }, [cand.rows, q, statusF, deptF, sourceF]);

  async function loadCriteria() {
    const { data } = await createClient().from("rubric_criteria").select("*").order("sort_order");
    const list = (data ?? []) as RubricCriterion[];
    setCriteria(list);
    return list;
  }

  async function onExport(department?: DepartmentCode) {
    setBusy(true);
    try {
      const supabase = createClient();
      const [c, e, r] = await Promise.all([
        fetchAll<Candidate>(supabase, "candidates"),
        fetchAll<Evaluation>(supabase, "evaluations"),
        loadCriteria(),
      ]);
      exportResults(c, e, r, department);
      toast.success(`Đã xuất ${department ? `${department}: ` : ""}${department ? c.filter((candidate) => candidate.department === department).length : c.length} thí sinh`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!editing) return;
    setBusy(true);
    const res = await saveCandidate(editing.id, editing.data);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Đã lưu thí sinh");
    setEditing(null);
    void cand.refetch();
  }

  async function onConfirm() {
    if (!confirm) return;
    setBusy(true);
    let error: string | null = null;
    if (confirm.kind === "reset") {
      const r = await createClient().rpc("admin_reset_candidate", { p_candidate_id: confirm.c.id });
      if (r.error) error = errorMessage(r.error);
    } else if (confirm.kind === "delete") {
      const r = await deleteCandidate(confirm.c.id);
      if (!r.ok) error = r.error;
    } else {
      const r = await deleteAllCandidates(confirmText);
      if (!r.ok) error = r.error;
    }
    setBusy(false);
    if (error) return toast.error(error);
    toast.success("Đã thực hiện");
    setConfirm(null);
    setConfirmText("");
    void cand.refetch();
    void evals.refetch();
  }

  const viewEval = viewing ? evalBy.get(viewing.id) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">
          Thí sinh <span className="text-muted-foreground">({cand.rows.length})</span>
        </h2>
        <LiveIndicator status={cand.status} />
        <ImportDialog onDone={() => void cand.refetch()} />
        <Button variant="outline" onClick={() => setEditing({ id: null, data: { ...EMPTY } })}>
          <Plus /> Thêm
        </Button>
        <Button variant="outline" onClick={() => void onExport()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Xuất kết quả Excel
        </Button>
        <div className="flex items-center gap-1.5">
          <select className={SELECT_CLS} value={exportDept} onChange={(event) => setExportDept(event.target.value as DepartmentCode)} aria-label="Chọn ban để xuất Excel">
            {DEPARTMENTS.map((department) => <option key={department.code} value={department.code}>{department.code} · {department.name}</option>)}
          </select>
          <Button variant="outline" onClick={() => void onExport(exportDept)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />} Xuất theo ban
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm mã ứng viên, MSSV, tên, SĐT, email…" className="h-9 pl-9" />
        </div>
        <select className={SELECT_CLS} value={statusF} onChange={(e) => setStatusF(e.target.value as CandidateStatus | "")} aria-label="Lọc trạng thái">
          <option value="">Mọi trạng thái</option>
          {(Object.keys(STATUS_LABEL) as CandidateStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className={SELECT_CLS} value={sourceF} onChange={(e) => setSourceF(e.target.value as "" | "CHECKIN")} aria-label="Lọc nguồn thêm">
          <option value="">Mọi nguồn</option>
          <option value="CHECKIN">Check-in bổ sung</option>
        </select>
        <DepartmentRadio name="candidate-filter-department" value={deptF} onChange={setDeptF} allowAll />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã</TableHead>
              <TableHead>MSSV</TableHead>
              <TableHead>Họ tên</TableHead>
              <TableHead>Giới tính</TableHead>
              <TableHead>Khóa</TableHead>
              <TableHead>SĐT</TableHead>
              <TableHead>Ban</TableHead>
              <TableHead>Ca</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Người bổ sung</TableHead>
              <TableHead className="text-right">Điểm TB</TableHead>
              <TableHead className="text-right">Thời lượng</TableHead>
              <TableHead className="w-40 text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => {
              const e = evalBy.get(c.id);
              const group = groupByCandidate.get(c.id);
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell className="font-mono text-xs">{c.student_number || (c.student_number_raw ? <span className="text-amber-700" title="MSSV cần xác minh">{c.student_number_raw} ⚠</span> : "—")}</TableCell>
                  <TableCell className="font-medium">{c.full_name}{c.source_candidate_id && <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-800">Lượt 2 từ CM</span>}</TableCell>
                  <TableCell>{GENDERS.find((gender) => gender.code === c.gender)?.name || "—"}</TableCell>
                  <TableCell>{c.student_cohort || "—"}</TableCell>
                  <TableCell className="tabular-nums">{c.phone}</TableCell>
                  <TableCell>{group?.departments.join(" · ") || c.department}</TableCell>
                  <TableCell className="max-w-40 truncate">{group?.shifts.join(" ; ") || c.shift}</TableCell>
                  <TableCell><div className="flex flex-wrap items-center gap-1"><StatusBadge status={c.status} />{c.challenge_status && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">{c.challenge_status === "WAITING" ? "Chờ thử thách" : c.challenge_status === "ASSIGNED" ? "Đã nhận thử thách" : c.challenge_status === "INTERVIEWING" ? "Đang thử thách" : "Đã xong thử thách"}</span>}</div></TableCell>
                  <TableCell className="min-w-44 text-xs">
                    {c.added_by_name ? <>
                      <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">{c.added_by_role === "CHECKIN" ? "Check-in bổ sung" : "Bổ sung tại Check-in"}</span>
                      <span className="mt-1 block font-medium">{c.added_by_name}</span>
                      {c.added_by_email && <span className="block text-muted-foreground">{c.added_by_email}</span>}
                    </> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {e?.average_score != null ? Number(e.average_score).toFixed(2) : ""}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {c.duration_seconds != null ? formatDuration(c.duration_seconds) : ""}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button size="icon-sm" variant="ghost" title="Xem chi tiết" aria-label="Xem chi tiết"
                        onClick={() => { setViewing(c); if (!criteria.length) void loadCriteria(); }}>
                        <Eye />
                      </Button>
                      <Button size="icon-sm" variant="ghost" title="Sửa" aria-label="Sửa"
                        onClick={() => setEditing({
                          id: c.id,
                          data: { code: c.code, full_name: c.full_name, student_number: c.student_number ?? "", student_number_raw: c.student_number_raw,
                            student_cohort: c.student_cohort ?? "", gender: c.gender ?? "", facebook_url: c.facebook_url ?? "",
                            phone: c.phone ?? "", email: c.email ?? "", department: c.department ?? "", shift: c.shift ?? "", cv_url: c.cv_url ?? "" },
                        })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" title="Đưa về Chưa đến" aria-label="Đưa về Chưa đến"
                        disabled={c.status === "NOT_ARRIVED"} onClick={() => setConfirm({ kind: "reset", c })}>
                        <RotateCcw />
                      </Button>
                      <Button size="icon-sm" variant="ghost" title="Xoá" aria-label="Xoá" className="text-red-600"
                        onClick={() => setConfirm({ kind: "delete", c })}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                  <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                  {cand.rows.length ? "Không có thí sinh phù hợp bộ lọc." : "Chưa có thí sinh. Bấm “Import Excel” để nhập danh sách."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" className="text-red-600" onClick={() => setConfirm({ kind: "deleteAll" })} disabled={!cand.rows.length}>
          <Trash2 /> Xoá toàn bộ thí sinh & kết quả
        </Button>
      </div>

      {/* Thêm / sửa */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Sửa thí sinh" : "Thêm thí sinh"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ["code", "Mã ứng viên *"], ["student_number", "MSSV"], ["full_name", "Họ tên *"],
                ["student_cohort", "Khóa sinh viên"], ["phone", "SĐT"], ["email", "Email"],
                ["facebook_url", "Link Facebook"], ["shift", "Ca phỏng vấn"], ["cv_url", "Link CV"],
              ] as [keyof CandidateInput, string][]).map(([k, label]) => (
                <div key={k} className={k === "cv_url" || k === "facebook_url" ? "grid gap-1.5 sm:col-span-2" : "grid gap-1.5"}>
                  <Label htmlFor={`f-${k}`}>{label}</Label>
                  <Input id={`f-${k}`} value={editing.data[k] ?? ""}
                    onChange={(e) => setEditing({ ...editing, data: { ...editing.data, [k]: e.target.value } })} />
                </div>
              ))}
              <div className="grid gap-1.5">
                <Label htmlFor="candidate-gender">Giới tính</Label>
                <select id="candidate-gender" className={SELECT_CLS} value={editing.data.gender ?? ""}
                  onChange={(event) => setEditing({ ...editing, data: { ...editing.data, gender: event.target.value } })}>
                  <option value="">Chưa chọn</option>
                  {GENDERS.map((gender) => <option key={gender.code} value={gender.code}>{gender.name}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Ban ứng tuyển</Label>
                <DepartmentRadio name="candidate-department" value={isDepartmentCode(editing.data.department) ? editing.data.department : ""}
                  onChange={(department) => setEditing({ ...editing, data: { ...editing.data, department } })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Huỷ</Button>
            <Button onClick={onSave} disabled={busy}>{busy && <Loader2 className="animate-spin" />}Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chi tiết */}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle>{viewing.full_name}</DialogTitle>
                <DialogDescription>
                  {viewing.code} · {groupByCandidate.get(viewing.id)?.departments.join(" · ") || viewing.department} · {groupByCandidate.get(viewing.id)?.shifts.join(" ; ") || viewing.shift}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <div className="flex items-center gap-2"><StatusBadge status={viewing.status} />
                  {safeUrl(viewing.cv_url) && (
                    <a href={safeUrl(viewing.cv_url)!} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                      Mở CV <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <dt className="text-muted-foreground">Check-in</dt><dd>{formatDateTime(viewing.checked_in_at) || "—"}</dd>
                  <dt className="text-muted-foreground">MSSV</dt><dd className="font-mono">{viewing.student_number || viewing.student_number_raw || "—"}{viewing.student_number_raw && " (cần xác minh)"}</dd>
                  <dt className="text-muted-foreground">Ban · Ca</dt><dd>{groupByCandidate.get(viewing.id)?.departments.join(" · ") || viewing.department || "—"}<br />{groupByCandidate.get(viewing.id)?.shifts.join(" ; ") || viewing.shift || "—"}</dd>
                  <dt className="text-muted-foreground">Khóa · Giới tính</dt><dd>{[viewing.student_cohort, GENDERS.find((gender) => gender.code === viewing.gender)?.name].filter(Boolean).join(" · ") || "—"}</dd>
                  <dt className="text-muted-foreground">Email</dt><dd className="break-all">{viewing.email || "—"}</dd>
                  <dt className="text-muted-foreground">SĐT</dt><dd>{viewing.phone || "—"}</dd>
                  <dt className="text-muted-foreground">Facebook</dt><dd>{safeUrl(viewing.facebook_url) ? <a href={safeUrl(viewing.facebook_url)!} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">Mở hồ sơ</a> : viewing.facebook_url || "—"}</dd>
                  <dt className="text-muted-foreground">Người bổ sung</dt><dd>{viewing.added_by_name ? `${viewing.added_by_name} (${viewing.added_by_email ?? ROLE_LABEL[viewing.added_by_role ?? "CHECKIN"]})` : "Không ghi nhận"}</dd>
                  {viewing.added_by_name && <><dt className="text-muted-foreground">Thêm lúc</dt><dd>{formatDateTime(viewing.created_at)}</dd></>}
                  <dt className="text-muted-foreground">Bắt đầu PV</dt><dd>{formatDateTime(viewEval?.started_at ?? viewing.interview_started_at) || "—"}</dd>
                  <dt className="text-muted-foreground">Kết thúc PV</dt><dd>{formatDateTime(viewEval?.ended_at ?? viewing.interview_ended_at) || "—"}</dd>
                  <dt className="text-muted-foreground">Thời lượng</dt><dd className="font-mono">{formatDuration(viewEval?.duration_seconds ?? viewing.duration_seconds)}</dd>
                  <dt className="text-muted-foreground">Người chấm</dt><dd>{viewEval?.interviewer_name || "—"}</dd>
                  <dt className="text-muted-foreground">Phòng - Bàn</dt><dd>{viewEval?.table_label || "—"}</dd>
                </dl>
                {viewEval ? (
                  <>
                    <ul className="divide-y rounded-lg border">
                      {criteria.map((k) => (
                        <li key={k.id} className="flex justify-between px-3 py-2">
                          <span>{k.name}</span>
                          <span className="font-semibold tabular-nums">
                            {viewEval.scores?.[k.id] ?? "–"}<span className="text-muted-foreground">/{k.max_score}</span>
                          </span>
                        </li>
                      ))}
                      <li className="flex justify-between bg-muted/50 px-3 py-2 font-semibold">
                        <span>Điểm TB (/10)</span>
                        <span className="tabular-nums">{viewEval.average_score != null ? Number(viewEval.average_score).toFixed(2) : "–"}</span>
                      </li>
                    </ul>
                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Nhận xét</p>
                      <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3">{viewEval.comment || "(Không có)"}</p>
                    </div>
                    {viewEval.challenge_ended_at && <section className="space-y-3 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
                      <div><h3 className="font-semibold">Vòng thử thách</h3><p className="text-xs text-muted-foreground">{viewEval.challenge_interviewer_name} · {viewEval.challenge_table_label}</p></div>
                      <ul className="divide-y rounded-lg border bg-background">
                        {criteria.map((criterion) => <li key={criterion.id} className="flex justify-between px-3 py-2 text-sm"><span>{criterion.name}</span><span>{viewEval.challenge_scores?.[criterion.id] ?? "—"}/{criterion.max_score}</span></li>)}
                        <li className="flex justify-between bg-muted/50 px-3 py-2 text-sm font-semibold"><span>Điểm trung bình</span><span>{viewEval.challenge_average_score ?? "—"}/10</span></li>
                      </ul>
                      <p className="whitespace-pre-wrap rounded-lg bg-background p-3 text-sm">{viewEval.challenge_comment || "Không có nhận xét"}</p>
                    </section>}
                  </>
                ) : (
                  <p className="text-muted-foreground">Chưa có phiếu đánh giá.</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) { setConfirm(null); setConfirmText(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "reset" ? "Đưa thí sinh về “Chưa đến”?" : confirm?.kind === "delete" ? "Xoá thí sinh?" : "Xoá toàn bộ dữ liệu thí sinh?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "reset" && `${confirm.c.full_name}: phiếu đánh giá (nếu có) sẽ bị xoá và bàn đang ngồi sẽ được giải phóng.`}
              {confirm?.kind === "delete" && `${confirm.c.full_name}${(groupByCandidate.get(confirm.c.id)?.applications.length ?? 0) > 1 ? " cùng các hồ sơ lượt phỏng vấn liên kết" : ""} và toàn bộ phiếu đánh giá sẽ bị xoá vĩnh viễn.`}
              {confirm?.kind === "deleteAll" && "Toàn bộ thí sinh và kết quả chấm sẽ bị xoá vĩnh viễn. Hãy xuất Excel trước. Gõ XOA TAT CA để xác nhận."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.kind === "deleteAll" && (
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="XOA TAT CA" autoFocus />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}
              disabled={busy || (confirm?.kind === "deleteAll" && confirmText !== "XOA TAT CA")}>
              {busy && <Loader2 className="animate-spin" />}Xác nhận
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
