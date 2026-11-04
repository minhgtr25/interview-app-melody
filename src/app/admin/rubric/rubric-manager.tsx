"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";
import type { RubricCriterion } from "@/lib/types";

type Row = Omit<RubricCriterion, "id"> & { id: string | null; _key: string };

export function RubricManager({ criteria, evaluationCount }: { criteria: RubricCriterion[]; evaluationCount: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() =>
    [...criteria].sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ ...c, weight: Number(c.weight), _key: c.id }))
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const set = (key: string, patch: Partial<Row>) => setRows((r) => r.map((x) => (x._key === key ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const c = r.slice();
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  function add() {
    setRows((r) => [
      ...r,
      { id: null, _key: crypto.randomUUID(), name: "", description: "", max_score: 10, weight: 1, sort_order: r.length + 1, active: true },
    ]);
  }

  async function save() {
    for (const r of rows) {
      if (!r.name.trim()) return toast.error("Tên tiêu chí không được trống");
      if (!(r.max_score >= 1 && r.max_score <= 100)) return toast.error(`"${r.name}": điểm tối đa 1-100`);
      if (!(r.weight > 0)) return toast.error(`"${r.name}": trọng số phải > 0`);
    }
    setBusy(true);
    const supabase = createClient();
    try {
      if (removed.length) {
        const { error } = await supabase.from("rubric_criteria").delete().in("id", removed);
        if (error) throw error;
      }
      const payload = rows.map((r, i) => ({
        name: r.name.trim(), description: r.description?.trim() || null,
        max_score: Math.round(r.max_score), weight: r.weight, sort_order: i + 1, active: r.active,
      }));
      const updates = rows.map((r, i) => ({ r, p: payload[i] })).filter(({ r }) => r.id);
      const inserts = rows.map((r, i) => ({ r, p: payload[i] })).filter(({ r }) => !r.id).map(({ p }) => p);
      for (const { r, p } of updates) {
        const { error } = await supabase.from("rubric_criteria").update(p).eq("id", r.id!);
        if (error) throw error;
      }
      if (inserts.length) {
        const { error } = await supabase.from("rubric_criteria").insert(inserts);
        if (error) throw error;
      }
      toast.success("Đã lưu tiêu chí. Giám khảo tải lại trang để áp dụng.");
      setRemoved([]);
      // Nạp lại từ DB để các tiêu chí mới có id thật (tránh insert trùng ở lần lưu sau)
      const { data, error } = await supabase.from("rubric_criteria").select("*").order("sort_order");
      if (error) throw error;
      setRows(((data ?? []) as RubricCriterion[]).map((c) => ({ ...c, weight: Number(c.weight), _key: c.id })));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">Tiêu chí chấm (Rubric)</h2>
          <p className="text-sm text-muted-foreground">
            Điểm TB = trung bình có trọng số, quy về thang 10. Tiêu chí ≤10 điểm hiển thị dạng nút bấm, lớn hơn dùng nút +/-.
          </p>
        </div>
        <Button variant="outline" onClick={add}><Plus /> Thêm tiêu chí</Button>
        <Button onClick={save} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Lưu thay đổi</Button>
      </div>

      {evaluationCount > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          Đã có {evaluationCount} phiếu chấm. Xoá tiêu chí sẽ làm mất cột điểm đó khi xuất Excel; nên dùng “Tắt” thay vì xoá.
        </p>
      )}

      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={r._key} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-[auto_1fr_auto]">
            <div className="flex gap-1 md:flex-col">
              <Button size="icon-xs" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Lên"><ArrowUp /></Button>
              <Button size="icon-xs" variant="ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Xuống"><ArrowDown /></Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem]">
              <Input value={r.name} onChange={(e) => set(r._key, { name: e.target.value })} placeholder="Tên tiêu chí" aria-label="Tên tiêu chí" />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Tối đa
                <Input type="number" min={1} max={100} value={r.max_score} className="h-8"
                  onChange={(e) => set(r._key, { max_score: Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Hệ số
                <Input type="number" min={0.1} step={0.1} value={r.weight} className="h-8"
                  onChange={(e) => set(r._key, { weight: Number(e.target.value) })} />
              </label>
              <Input value={r.description ?? ""} onChange={(e) => set(r._key, { description: e.target.value })}
                placeholder="Mô tả ngắn cho giám khảo (tuỳ chọn)" className="sm:col-span-3" aria-label="Mô tả" />
            </div>
            <div className="flex items-center gap-2 md:flex-col md:items-end">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={r.active} onChange={(e) => set(r._key, { active: e.target.checked })} className="size-4" />
                Bật
              </label>
              <Button size="icon-sm" variant="ghost" className="text-red-600" aria-label="Xoá tiêu chí"
                onClick={() => { if (r.id) setRemoved((x) => [...x, r.id!]); setRows((x) => x.filter((y) => y._key !== r._key)); }}>
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="text-center text-sm text-muted-foreground">Chưa có tiêu chí. Bấm “Thêm tiêu chí”.</p>}
    </div>
  );
}
