"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, ExternalLink, KeyRound, Loader2, Pencil, Plus, Trash2, Wand2, AlertTriangle, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ROLE_LABEL, type InterviewTable, type Profile, type Room, type UserRole } from "@/lib/types";
import { normalizeText } from "@/lib/format";
import { createAccount, deleteAccount, deleteAllInterviewerAccounts, resetPassword, updateAccount } from "../actions";

const SELECT_CLS = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm";
const ROLES = Object.keys(ROLE_LABEL) as UserRole[];

/** Mật khẩu ngẫu nhiên dễ đọc (bỏ ký tự dễ nhầm 0/O, 1/l/I). */
function genPassword(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

function tableAccountEmail(roomName: string, tableName: string) {
  const localPart = `${roomName}-${tableName}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${localPart}@club.local`;
}

type Form = { id: string | null; email: string; password: string; fullName: string; role: UserRole; tableId: string; isDebateJudge: boolean };

export function AccountsManager({
  profiles,
  tables,
  rooms,
  currentUserId,
  serviceKeyConfigured,
}: {
  profiles: Profile[];
  tables: InterviewTable[];
  rooms: Room[];
  currentUserId: string;
  serviceKeyConfigured: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(null);
  const [pwFor, setPwFor] = useState<{ p: Profile; pw: string } | null>(null);
  const [delFor, setDelFor] = useState<Profile | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "">("");

  const tableLabel = useMemo(() => {
    const rn = new Map(rooms.map((r) => [r.id, r]));
    return new Map(tables.map((t) => [t.id, `${rn.get(t.room_id)?.name ?? ""} · ${t.name} (${t.department ?? "Chưa chọn Ban"})`]));
  }, [tables, rooms]);
  const tableEmail = (tableId: string) => {
    const table = tables.find((item) => item.id === tableId);
    const room = rooms.find((item) => item.id === table?.room_id);
    return table && room ? tableAccountEmail(room.name, table.name) : "";
  };

  const tableOptions = useMemo(() => {
    const order = new Map(rooms.map((r) => [r.id, r.sort_order]));
    return [...tables].sort((a, b) => (order.get(a.room_id) ?? 0) - (order.get(b.room_id) ?? 0) || a.sort_order - b.sort_order);
  }, [tables, rooms]);

  // Một bàn chỉ có một tài khoản đại diện; cảnh báo bàn chưa có tài khoản.
  const judgesPerTable = useMemo(() => {
    const m = new Map<string, number>();
    profiles.forEach((p) => p.role === "INTERVIEWER" && p.table_id && m.set(p.table_id, (m.get(p.table_id) ?? 0) + 1));
    return m;
  }, [profiles]);
  const uncovered = tables.filter((t) => !judgesPerTable.get(t.id));

  const sorted = profiles.filter((profile) => {
    if (roleFilter && profile.role !== roleFilter) return false;
    return !query || normalizeText(`${profile.full_name} ${profile.email} ${ROLE_LABEL[profile.role]} ${tableLabel.get(profile.table_id ?? "") ?? ""}`).includes(normalizeText(query));
  }).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));

  async function save() {
    if (!form) return;
    if (!form.id && form.role === "INTERVIEWER" && !form.isDebateJudge && !form.tableId) return toast.error("Chọn bàn để tạo tài khoản Giám khảo");
    if (!form.id && form.role === "INTERVIEWER" && form.password.length !== 8) return toast.error("Mật khẩu Giám khảo phải đúng 8 ký tự");
    setBusy(true);
    const res = form.id
      ? await updateAccount({ id: form.id, fullName: form.fullName, role: form.role, tableId: form.tableId || null, isDebateJudge: form.isDebateJudge })
      : await createAccount({ email: form.email, password: form.password, fullName: form.fullName, role: form.role, tableId: form.tableId || null, isDebateJudge: form.isDebateJudge });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    if (!form.id) setCreated({ email: res.data?.email ?? form.email.trim().toLowerCase(), password: res.data?.password ?? form.password });
    toast.success(form.id ? "Đã cập nhật tài khoản" : "Đã tạo tài khoản");
    setForm(null);
    router.refresh();
  }

  async function doReset() {
    if (!pwFor) return;
    setBusy(true);
    const res = await resetPassword(pwFor.p.id, pwFor.pw);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setCreated({ email: pwFor.p.email, password: pwFor.pw });
    setPwFor(null);
  }

  async function doDelete() {
    if (!delFor) return;
    setBusy(true);
    const res = await deleteAccount(delFor.id);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Đã xoá tài khoản");
    setDelFor(null);
    router.refresh();
  }

  async function doDeleteAllInterviewers() {
    setBusy(true);
    const res = await deleteAllInterviewerAccounts();
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    const { deleted, failed } = res.data ?? { deleted: 0, failed: 0 };
    if (failed) toast.error(`Đã xóa ${deleted} tài khoản; ${failed} tài khoản chưa xóa được`);
    else toast.success(deleted ? `Đã xóa ${deleted} tài khoản Giám khảo` : "Không có tài khoản Giám khảo nào để xóa");
    setDeleteAllOpen(false);
    router.refresh();
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast.success("Đã sao chép"), () => toast.error("Không sao chép được"));
  }

  return (
    <div className="space-y-5">
      <div className="app-page-heading flex-wrap">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">Tài khoản nhân sự</h2>
          <p className="text-sm text-muted-foreground">{profiles.length} tài khoản · Phân quyền và gán giám khảo vào bàn</p>
        </div>
        <Button
          disabled={!serviceKeyConfigured}
          onClick={() => setForm({ id: null, email: "", password: genPassword(8), fullName: "", role: "INTERVIEWER", tableId: "", isDebateJudge: false })}
        >
          <Plus /> Cấp tài khoản
        </Button>
      </div>

      {!serviceKeyConfigured && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          Chưa cấu hình SUPABASE_SERVICE_ROLE_KEY trên server nên không thể tạo / đặt lại mật khẩu. Xem HUONG_DAN_SU_DUNG.md.
        </p>
      )}
      {uncovered.length > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <AlertTriangle className="size-4 shrink-0" />
          Bàn chưa có tài khoản đại diện: {uncovered.map((t) => tableLabel.get(t.id)).join(", ")}
        </p>
      )}

      <div className="app-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Tìm tài khoản</h3>
          <p className="text-xs text-muted-foreground" aria-live="polite">Hiển thị {sorted.length}/{profiles.length} tài khoản</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm tên, email, vai trò hoặc phòng/bàn" className="pl-9 pr-9" aria-label="Tìm tài khoản" />
            {query && <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-1/2 -translate-y-1/2"
              aria-label="Xóa nội dung tìm kiếm" onClick={() => setQuery("")}><X /></Button>}
          </div>
          <select className={SELECT_CLS + " sm:w-52"} value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as UserRole | "")} aria-label="Lọc theo vai trò">
            <option value="">Tất cả vai trò</option>
            {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Họ tên</TableHead>
              <TableHead>Email đăng nhập</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Bàn phụ trách</TableHead>
              <TableHead className="w-32 text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.full_name || "—"}{p.is_debate_judge && <Badge className="ml-2" variant="outline">Debate {p.debate_judge_position ?? "· chưa phân bàn"}</Badge>}
                  {p.id === currentUserId && <span className="ml-2 text-xs text-muted-foreground">(bạn)</span>}
                </TableCell>
                <TableCell className="font-mono text-xs">{p.email}</TableCell>
                <TableCell><Badge variant="secondary">{ROLE_LABEL[p.role]}</Badge></TableCell>
                <TableCell className="text-sm">
                  {p.role === "INTERVIEWER" ? (p.table_id ? `${tableLabel.get(p.table_id) ?? "?"}${p.is_debate_judge ? ` · Giám khảo ${p.debate_judge_position}` : ""}` : <span className="text-red-600">Chưa phân bàn</span>) : ""}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    {p.is_debate_judge && p.table_id && <Link href={`/admin-preview/${p.table_id}?judgeId=${p.id}`}
                      className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
                      title={`Mở giao diện Giám khảo Debate ${p.debate_judge_position}`}
                      aria-label={`Mở giao diện Giám khảo Debate ${p.debate_judge_position} · ${p.full_name || p.email}`}>
                      <ExternalLink className="size-4" />
                    </Link>}
                    <Button size="icon-sm" variant="ghost" title="Sửa" aria-label="Sửa"
                      onClick={() => setForm({ id: p.id, email: p.email, password: "", fullName: p.full_name, role: p.role, tableId: p.table_id ?? "", isDebateJudge: p.is_debate_judge })}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Đặt lại mật khẩu" aria-label="Đặt lại mật khẩu"
                      disabled={!serviceKeyConfigured} onClick={() => setPwFor({ p, pw: genPassword(p.role === "INTERVIEWER" ? 8 : 12) })}>
                      <KeyRound />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Xoá" aria-label="Xoá" className="text-red-600"
                      disabled={!serviceKeyConfigured || p.id === currentUserId} onClick={() => setDelFor(p)}>
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {sorted.length === 0 && <TableRow><TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
              {profiles.length ? "Không tìm thấy tài khoản phù hợp." : "Chưa có tài khoản nhân sự."}
            </TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end border-t pt-4">
        <Button variant="ghost" className="text-destructive" disabled={!serviceKeyConfigured || !profiles.some((profile) => profile.role === "INTERVIEWER")}
          onClick={() => setDeleteAllOpen(true)}>
          <Trash2 /> Xóa toàn bộ Giám khảo ({profiles.filter((profile) => profile.role === "INTERVIEWER").length})
        </Button>
      </div>

      {/* Tạo / sửa */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Sửa tài khoản" : "Cấp tài khoản mới"}</DialogTitle>
            {!form?.id && <DialogDescription>Tài khoản được kích hoạt ngay, không cần xác nhận email.</DialogDescription>}
          </DialogHeader>
          {form && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="a-name">Họ tên</Label>
                <Input id="a-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="a-email">Email đăng nhập</Label>
                <Input id="a-email" type="email" value={!form.id && form.role === "INTERVIEWER" && !form.isDebateJudge ? tableEmail(form.tableId) : form.email} disabled={!!form.id || (!form.id && form.role === "INTERVIEWER" && !form.isDebateJudge)}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="giamkhao1@club.local" />
              </div>
              {!form.id && (
                <div className="grid gap-1.5">
                  <Label htmlFor="a-pw">Mật khẩu ({form.role === "INTERVIEWER" ? "đúng 8 ký tự" : "tối thiểu 8 ký tự"})</Label>
                  <div className="flex gap-2">
                    <Input id="a-pw" value={form.password} maxLength={form.role === "INTERVIEWER" ? 8 : undefined} onChange={(e) => setForm({ ...form, password: e.target.value })} className="font-mono" />
                    <Button type="button" variant="outline" size="icon" title="Tạo ngẫu nhiên" aria-label="Tạo mật khẩu ngẫu nhiên"
                      onClick={() => setForm({ ...form, password: genPassword(form.role === "INTERVIEWER" ? 8 : 12) })}>
                      <Wand2 />
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="a-role">Vai trò</Label>
                  <select id="a-role" className={SELECT_CLS} value={form.role}
                  disabled={form.id === currentUserId}
                  onChange={(e) => { const role = e.target.value as UserRole; setForm({ ...form, role, password: !form.id && role === "INTERVIEWER" && form.role !== "INTERVIEWER" ? genPassword(8) : form.password }); }}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
              {form.role === "INTERVIEWER" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isDebateJudge} onChange={(e) => setForm({ ...form, isDebateJudge: e.target.checked, tableId: "", email: "" })} />Giám khảo Debate (cấp riêng, chọn làm Giám khảo 1 hoặc 2 khi tạo bàn)</label>}
              {form.role === "INTERVIEWER" && !form.isDebateJudge && (
                <div className="grid gap-1.5">
                  <Label htmlFor="a-table">Bàn dùng tài khoản này làm đại diện</Label>
                  <select id="a-table" className={SELECT_CLS} value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
                    <option value="">— Chọn bàn —</option>
                    {tableOptions.filter((t) => !rooms.find((room) => room.id === t.room_id)?.is_challenge &&
                      (!judgesPerTable.get(t.id) || t.id === form.tableId)).map((t) => (
                      <option key={t.id} value={t.id}>
                        {tableLabel.get(t.id)} {judgesPerTable.get(t.id) ? "(đang gán)" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">Mỗi bàn dùng một tài khoản đăng nhập chung trên máy của bàn; các giám khảo khác không cần tài khoản riêng.</p>
                  {!form.id && form.tableId && <p className="text-xs text-muted-foreground">Email sẽ được tạo theo tên phòng và bàn: <span className="font-mono">{tableEmail(form.tableId)}</span></p>}
                  {tables.length === 0 && <p className="text-xs text-red-600">Chưa có bàn nào. Tạo ở mục “Phòng & Bàn”.</p>}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Huỷ</Button>
            <Button onClick={save} disabled={busy || (!!form && !form.id && form.role === "INTERVIEWER" && ((!form.isDebateJudge && !form.tableId) || form.password.length !== 8))}>{busy && <Loader2 className="animate-spin" />}{form?.id ? "Lưu" : "Tạo tài khoản"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hiển thị thông tin đăng nhập 1 lần */}
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Thông tin đăng nhập</DialogTitle>
            <DialogDescription>Gửi cho thành viên qua kênh riêng. Mật khẩu chỉ hiển thị một lần này.</DialogDescription>
          </DialogHeader>
          {created && (
            <div className="grid gap-2 rounded-lg bg-muted p-4 font-mono text-sm">
              <p>Email: {created.email}</p>
              <p>Mật khẩu: {created.password}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline"
              onClick={() => created && copy(`Link: ${window.location.origin}/login\nEmail: ${created.email}\nMật khẩu: ${created.password}`)}>
              <Copy /> Sao chép
            </Button>
            <Button onClick={() => setCreated(null)}>Đã lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Đặt lại mật khẩu */}
      <AlertDialog open={!!pwFor} onOpenChange={(o) => !o && setPwFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đặt lại mật khẩu?</AlertDialogTitle>
            <AlertDialogDescription>{pwFor?.p.email} sẽ dùng mật khẩu mới dưới đây.</AlertDialogDescription>
          </AlertDialogHeader>
          {pwFor && (
            <Input value={pwFor.pw} maxLength={pwFor.p.role === "INTERVIEWER" ? 8 : undefined} onChange={(e) => setPwFor({ ...pwFor, pw: e.target.value })} className="font-mono" aria-label="Mật khẩu mới" />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={doReset} disabled={busy}>{busy && <Loader2 className="animate-spin" />}Đặt lại</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Xoá */}
      <AlertDialog open={!!delFor} onOpenChange={(o) => !o && setDelFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá tài khoản?</AlertDialogTitle>
            <AlertDialogDescription>
              {delFor?.email} sẽ không đăng nhập được nữa. Các phiếu đánh giá đã chấm vẫn được giữ (kèm tên người chấm).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doDelete} disabled={busy}>Xoá</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteAllOpen} onOpenChange={(open) => !busy && setDeleteAllOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa toàn bộ tài khoản Giám khảo?</AlertDialogTitle>
            <AlertDialogDescription>
              Thao tác này xóa {profiles.filter((profile) => profile.role === "INTERVIEWER").length} tài khoản Giám khảo và đăng xuất các phiên hiện tại. Phiếu đánh giá đã lưu vẫn được giữ. Cần giải phóng tất cả bàn trước khi xóa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Hủy</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doDeleteAllInterviewers} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Xóa toàn bộ Giám khảo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
