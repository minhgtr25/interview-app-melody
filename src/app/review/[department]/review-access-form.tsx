"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DEPARTMENTS } from "@/lib/departments";
import { unlockReviewPortal } from "./actions";

export function ReviewAccessForm({ department }: { department: (typeof DEPARTMENTS)[number] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await unlockReviewPortal(department.code, code);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setCode("");
    router.refresh();
  }

  return <main className="grid min-h-dvh bg-[#f4f3ef] lg:grid-cols-[1fr_1.1fr]">
    <section className="flex flex-col justify-between bg-[#162723] px-6 py-9 text-[#f7f6f0] sm:px-12 lg:px-16">
      <p className="font-mono text-xs tracking-[0.25em] text-[#c6ab7b]">CLB CASTING / {department.code}</p>
      <div className="py-16"><p className="mb-5 text-sm text-[#c6ab7b]">CHỐT KẾT QUẢ PHỎNG VẤN</p>
        <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Ban {department.name}</h1>
        <p className="mt-5 max-w-md text-[#c4cfca]">Xem phiếu chấm, lọc ứng viên và đưa ra quyết định cho Ban của bạn.</p>
      </div>
      <p className="text-xs text-[#a5b7ae]">Link chỉ hoạt động khi Admin mở cổng chấm.</p>
    </section>
    <section className="flex items-center justify-center px-6 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="flex size-12 items-center justify-center rounded-xl bg-[#e5e9e2] text-[#23483b]"><KeyRound className="size-6" /></div>
        <div><h2 className="text-2xl font-semibold tracking-tight">Nhập mã truy cập</h2>
          <p className="mt-2 text-sm text-muted-foreground">Admin cấp mã 4 chữ hoặc số riêng cho Ban {department.code}.</p></div>
        <div className="space-y-2"><label htmlFor="review-code" className="block text-sm font-medium">Mã của Ban</label>
          <Input id="review-code" autoComplete="off" autoCapitalize="characters" autoFocus
            maxLength={4} value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            className="h-14 font-mono text-2xl tracking-[0.4em]" placeholder="A7K2" aria-invalid={!!error} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
        <Button type="submit" className="h-11 w-full" disabled={busy || code.length !== 4}>
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Mở danh sách
        </Button>
      </form>
    </section>
  </main>;
}
