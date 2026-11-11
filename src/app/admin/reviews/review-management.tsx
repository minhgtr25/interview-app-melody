"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCopy, Download, ExternalLink, KeyRound, LockKeyhole, UnlockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DEPARTMENTS, type DepartmentCode } from "@/lib/departments";
import { formatDateTime } from "@/lib/format";
import { candidateApplicationShift } from "@/lib/candidate-application-day";
import type { Candidate, Evaluation, ReviewDecision, ReviewDecisionEvent, ReviewPortal } from "@/lib/types";
import { closeReviewPortal, openReviewPortal } from "./actions";

const DECISIONS = { PASS: "Đỗ", FAIL: "Trượt", CONSIDER: "Cân nhắc" } as const;

export function ReviewManagement({ portals, candidates, evaluations, decisions, events }: {
  portals: ReviewPortal[];
  candidates: Candidate[];
  evaluations: Evaluation[];
  decisions: ReviewDecision[];
  events: ReviewDecisionEvent[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<DepartmentCode | null>(null);
  const [confirm, setConfirm] = useState<{ department: DepartmentCode; action: "open" | "close" } | null>(null);
  const [revealed, setRevealed] = useState<Partial<Record<DepartmentCode, string>>>({});
  const [portalBase, setPortalBase] = useState("");
  useEffect(() => {
    try { setPortalBase(localStorage.getItem("review-portal-base") || window.location.origin); }
    catch { setPortalBase(window.location.origin); }
  }, []);
  const portalByDepartment = useMemo(() => new Map(portals.map((portal) => [portal.department, portal])), [portals]);
  const candidateById = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const completedCandidates = useMemo(() => candidates.filter((candidate) => candidate.status === "COMPLETED"), [candidates]);
  const counts = useMemo(() => new Map(DEPARTMENTS.map((item) => {
    const ids = new Set(completedCandidates.filter((candidate) => candidate.department === item.code).map((candidate) => candidate.id));
    const outcomes = decisions.filter((decision) => ids.has(decision.candidate_id));
    return [item.code, { completed: ids.size, pass: outcomes.filter((row) => row.decision === "PASS").length,
      fail: outcomes.filter((row) => row.decision === "FAIL").length,
      consider: outcomes.filter((row) => row.decision === "CONSIDER").length }] as const;
  })), [completedCandidates, decisions]);

  const linkValid = (() => {
    try { return ["http:", "https:"].includes(new URL(portalBase).protocol); }
    catch { return false; }
  })();
  const portalLink = (department: DepartmentCode) => `${portalBase.trim().replace(/\/+$/, "")}/review/${department}`;

  async function performAction() {
    if (!confirm) return;
    const { department, action } = confirm;
    setConfirm(null);
    setBusy(department);
    const result = action === "open" ? await openReviewPortal(department) : await closeReviewPortal(department);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    if (action === "open" && result.data) {
      setRevealed((previous) => ({ ...previous, [department]: result.data!.code }));
      toast.success(`Đã mở cổng chấm Ban ${department}. Hãy lưu mã ngay.`);
    } else {
      setRevealed((previous) => ({ ...previous, [department]: undefined }));
      toast.success(`Đã đóng cổng chấm Ban ${department}`);
    }
    router.refresh();
  }

  async function copyCredentials(department: DepartmentCode) {
    const code = revealed[department];
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`Ban ${department}\nLink: ${portalLink(department)}\nMã truy cập: ${code}`);
      toast.success("Đã sao chép link và mã");
    } catch { toast.error("Không sao chép được, hãy dùng nút tải file"); }
  }

  function downloadCredentials(department: DepartmentCode) {
    const code = revealed[department];
    if (!code) return;
    const blob = new Blob([`Ban ${department}\nLink: ${portalLink(department)}\nMã truy cập: ${code}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `link-cham-${department}.txt`; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadResults() {
    const XLSX = await import("xlsx");
    const evaluationById = new Map(evaluations.map((item) => [item.candidate_id, item]));
    const decisionById = new Map(decisions.map((item) => [item.candidate_id, item]));
    const rows = completedCandidates.map((candidate) => {
      const evaluation = evaluationById.get(candidate.id);
      const decision = decisionById.get(candidate.id);
      return {
        "Ban": candidate.department ?? "", "Mã": candidate.code, "Họ tên": candidate.full_name,
        "Ca": candidateApplicationShift(candidate, evaluation) ?? "", "Điểm TB": evaluation?.average_score == null ? "" : Number(evaluation.average_score),
        "Phòng - Bàn": evaluation?.table_label ?? "", "Nhận xét phỏng vấn": evaluation?.comment ?? "",
        "Kết quả": decision ? DECISIONS[decision.decision] : "Chưa chốt",
        "Ghi chú chốt": decision?.note ?? "", "Chốt lúc": decision ? formatDateTime(decision.updated_at) : "",
      };
    });
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [10, 14, 28, 18, 12, 24, 45, 14, 35, 20].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(book, sheet, "Kết quả từng Ban");
    XLSX.writeFile(book, "tong-hop-chot-ket-qua.xlsx");
  }

  return <div className="space-y-6">
    <div className="app-page-heading flex-wrap">
      <div><h2 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">Chốt kết quả</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Mở Ban để tạo link và mã 4 ký tự. Mã chỉ hiển thị một lần; tạo mã mới sẽ thu hồi quyền truy cập cũ.</p></div>
      <Button variant="outline" onClick={() => void downloadResults()}><Download /> Xuất kết quả đã chốt</Button>
    </div>
    <div className="app-panel max-w-xl space-y-1.5 p-4">
      <label htmlFor="review-base" className="block text-sm font-medium">Địa chỉ web để chia sẻ</label>
      <Input id="review-base" type="url" value={portalBase} onChange={(event) => {
        const value = event.target.value;
        setPortalBase(value);
        try { localStorage.setItem("review-portal-base", value); } catch { /* storage bị chặn */ }
      }} placeholder="https://casting.example.com" />
      <p className="text-xs text-muted-foreground">Nếu đang dùng localhost, nhập địa chỉ web mà người của Ban mở được từ máy của họ.</p>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      {DEPARTMENTS.map((department) => {
        const portal = portalByDepartment.get(department.code);
        const count = counts.get(department.code)!;
        const code = revealed[department.code];
        return <section key={department.code} className="rounded-xl border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-mono text-xs font-semibold tracking-widest text-muted-foreground">{department.code}</p>
              <h3 className="mt-1 text-lg font-semibold">{department.name}</h3></div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${portal?.active ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>
              {portal?.active ? "Đang mở" : "Đang đóng"}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 border-y py-3 text-center text-sm">
            <div><p className="font-mono text-lg font-semibold">{count.completed}</p><p className="text-xs text-muted-foreground">Đã PV</p></div>
            <div><p className="font-mono text-lg font-semibold text-emerald-700">{count.pass}</p><p className="text-xs text-muted-foreground">Đỗ</p></div>
            <div><p className="font-mono text-lg font-semibold text-red-700">{count.fail}</p><p className="text-xs text-muted-foreground">Trượt</p></div>
            <div><p className="font-mono text-lg font-semibold text-amber-700">{count.consider}</p><p className="text-xs text-muted-foreground">Cân nhắc</p></div>
          </div>
          {portal?.active && <p className="mt-3 text-xs text-muted-foreground">Mở lúc {formatDateTime(portal.opened_at)}</p>}
          {code && <div className="mt-4 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-950">Lưu mã ngay, trang sẽ không hiện lại mã này.</p>
            <p className="break-all font-mono text-xs">{portalLink(department.code)}</p>
            <p className="font-mono text-2xl font-bold tracking-[0.3em]">{code}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!linkValid} onClick={() => void copyCredentials(department.code)}><ClipboardCopy /> Sao chép</Button>
              <Button size="sm" variant="outline" disabled={!linkValid} onClick={() => downloadCredentials(department.code)}><Download /> Tải file</Button>
            </div>
          </div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy === department.code} onClick={() => setConfirm({ department: department.code, action: "open" })}>
              {portal?.active ? <KeyRound /> : <UnlockKeyhole />}{portal?.active ? "Tạo mã mới" : "Mở cổng & tạo mã"}
            </Button>
            {portal?.active && <Button variant="outline" disabled={busy === department.code}
              onClick={() => setConfirm({ department: department.code, action: "close" })}><LockKeyhole /> Đóng cổng</Button>}
            {portal?.active && <a href={`/review/${department.code}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-sm hover:bg-muted">Xem link <ExternalLink className="size-4" /></a>}
          </div>
        </section>;
      })}
    </div>
    <section className="space-y-3 border-t pt-5">
      <div><h3 className="text-lg font-semibold">Thay đổi gần đây</h3>
        <p className="text-sm text-muted-foreground">Lưu các lần chốt và sửa quyết định để Admin đối chiếu.</p></div>
      <div className="divide-y rounded-xl border bg-card">
        {[...events].sort((a, b) => b.changed_at.localeCompare(a.changed_at)).slice(0, 20).map((event) =>
          <div key={event.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_7rem_11rem] sm:items-center">
            <span className="font-mono text-xs text-muted-foreground">{event.department}</span>
            <span><strong>{candidateById.get(event.candidate_id)?.full_name ?? "Thí sinh đã xóa"}</strong>
              {event.note && <span className="ml-2 text-muted-foreground">· {event.note}</span>}</span>
            <span className="font-medium">{DECISIONS[event.decision]}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(event.changed_at)}</span>
          </div>)}
        {events.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Chưa có quyết định nào.</p>}
      </div>
    </section>
    <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>
        {confirm?.action === "close" ? "Đóng cổng chấm của Ban?" : "Mở cổng và cấp mã mới?"}
      </AlertDialogTitle><AlertDialogDescription>
        {confirm?.action === "close" ? "Link và các phiên đang mở sẽ ngừng truy cập ngay. Quyết định đã chốt vẫn được giữ."
          : "Mã cũ và các phiên đã mở sẽ hết hiệu lực. Mã mới chỉ hiển thị một lần sau khi tạo."}
      </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel>Hủy</AlertDialogCancel><AlertDialogAction onClick={() => void performAction()}>Xác nhận</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>;
}
