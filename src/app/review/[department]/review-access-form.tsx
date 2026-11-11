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

  return <main className="grid min-h-dvh bg-background lg:grid-cols-[minmax(18rem,0.82fr)_1.18fr]">
    <section className="relative flex flex-col justify-between overflow-hidden bg-primary px-6 py-7 text-primary-foreground sm:px-10 sm:py-9 lg:min-h-dvh lg:px-14 lg:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute -right-28 -top-28 size-80 rounded-full border border-white/10" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full border border-white/10" />
      <p className="relative font-mono text-xs tracking-[0.2em] text-white/70">CLB CASTING <span className="mx-1.5 text-white/35">/</span> {department.code}</p>
      <div className="relative py-10 lg:py-16"><p className="mb-4 text-xs font-semibold tracking-[0.14em] text-white/65">CHỐT KẾT QUẢ PHỎNG VẤN</p>
        <h1 className="max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl lg:text-[2.75rem]">Ban {department.name}</h1>
        <p className="mt-4 max-w-md text-sm leading-6 text-white/75">Xem phiếu chấm, lọc ứng viên và đưa ra quyết định cho Ban của bạn.</p>
      </div>
      <p className="relative text-xs text-white/60">Link chỉ hoạt động khi Admin mở cổng chấm.</p>
    </section>
    <section className="flex items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
      <form onSubmit={submit} className="app-panel w-full max-w-md space-y-5 p-6 sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><KeyRound className="size-5" /></div>
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
