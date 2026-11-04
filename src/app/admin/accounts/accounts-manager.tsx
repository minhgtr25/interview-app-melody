"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, Pencil, Plus, Trash2, Wand2, AlertTriangle } from "lucide-react";
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
import { createAccount, deleteAccount, resetPassword, updateAccount } from "../actions";

const SELECT_CLS = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm";
const ROLES = Object.keys(ROLE_LABEL) as UserRole[];

/** Mật khẩu ngẫu nhiên dễ đọc (bỏ ký tự dễ nhầm 0/O, 1/l/I). */
function genPassword(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

type Form = { id: string | null; email: string; password: string; fullName: string; role: UserRole; tableId: string };

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
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const tableLabel = useMemo(() => {
    const rn = new Map(rooms.map((r) => [r.id, r]));
    return new Map(tables.map((t) => [t.id, `${rn.get(t.room_id)?.name ?? ""} · ${t.name} (${t.department ?? "Chưa chọn Ban"})`]));
  }, [tables, rooms]);

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

  const sorted = [...profiles].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));

  async function save() {
    if (!form) return;
    setBusy(true);
    const res = form.id
      ? await updateAccount({ id: form.id, fullName: form.fullName, role: form.role, tableId: form.tableId || null })
      : await createAccount({ email: form.email, password: form.password, fullName: form.fullName, role: form.role, tableId: form.tableId || null });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    if (!form.id) setCreated({ email: form.email.trim().toLowerCase(), password: form.password });
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

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast.success("Đã sao chép"), () => toast.error("Không sao chép được"));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">
          Tài khoản nhân sự <span className="text-muted-foreground">({profiles.length})</span>
        </h2>
        <Button
          disabled={!serviceKeyConfigured}
          onClick={() => setForm({ id: null, email: "", password: genPassword(), fullName: "", role: "INTERVIEWER", tableId: "" })}
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
                  {p.full_name || "—"}
                  {p.id === currentUserId && <span className="ml-2 text-xs text-muted-foreground">(bạn)</span>}
                </TableCell>
                <TableCell className="font-mono text-xs">{p.email}</TableCell>
                <TableCell><Badge variant="secondary">{ROLE_LABEL[p.role]}</Badge></TableCell>
                <TableCell className="text-sm">
                  {p.role === "INTERVIEWER" ? (p.table_id ? tableLabel.get(p.table_id) ?? "?" : <span className="text-red-600">Chưa phân bàn</span>) : ""}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    <Button size="icon-sm" variant="ghost" title="Sửa" aria-label="Sửa"
                      onClick={() => setForm({ id: p.id, email: p.email, password: "", fullName: p.full_name, role: p.role, tableId: p.table_id ?? "" })}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Đặt lại mật khẩu" aria-label="Đặt lại mật khẩu"
                      disabled={!serviceKeyConfigured} onClick={() => setPwFor({ p, pw: genPassword() })}>
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
          </TableBody>
        </Table>
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
                <Input id="a-email" type="email" value={form.email} disabled={!!form.id}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="giamkhao1@club.local" />
              </div>
              {!form.id && (
                <div className="grid gap-1.5">
                  <Label htmlFor="a-pw">Mật khẩu (tối thiểu 8 ký tự)</Label>
                  <div className="flex gap-2">
                    <Input id="a-pw" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="font-mono" />
                    <Button type="button" variant="outline" size="icon" title="Tạo ngẫu nhiên" aria-label="Tạo mật khẩu ngẫu nhiên"
                      onClick={() => setForm({ ...form, password: genPassword() })}>
                      <Wand2 />
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="a-role">Vai trò</Label>
                <select id="a-role" className={SELECT_CLS} value={form.role}
                  disabled={form.id === currentUserId}
                  onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
              {form.role === "INTERVIEWER" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="a-table">Bàn dùng tài khoản này làm đại diện</Label>
                  <select id="a-table" className={SELECT_CLS} value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
                    <option value="">— Chọn bàn —</option>
                    {tableOptions.filter((t) => !judgesPerTable.get(t.id) || t.id === form.tableId).map((t) => (
                      <option key={t.id} value={t.id}>
                        {tableLabel.get(t.id)} {judgesPerTable.get(t.id) ? "(đang gán)" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">Mỗi bàn dùng một tài khoản đăng nhập chung trên máy của bàn; các giám khảo khác không cần tài khoản riêng.</p>
                  {tables.length === 0 && <p className="text-xs text-red-600">Chưa có bàn nào. Tạo ở mục “Phòng & Bàn”.</p>}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Huỷ</Button>
            <Button onClick={save} disabled={busy}>{busy && <Loader2 className="animate-spin" />}{form?.id ? "Lưu" : "Tạo tài khoản"}</Button>
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
            <Input value={pwFor.pw} onChange={(e) => setPwFor({ ...pwFor, pw: e.target.value })} className="font-mono" aria-label="Mật khẩu mới" />
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
    </div>
  );
}
