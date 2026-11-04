"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

/**
 * Bù lệch giờ giữa thiết bị và server: các mốc started_at do Postgres ghi,
 * nên đồng hồ đếm giờ phải tính theo giờ server, không theo giờ máy.
 * Đo lại khi tab được mở lại (máy ngủ có thể làm lệch giờ).
 */
const ClockContext = createContext<number>(0);

async function measureOffset(): Promise<number | null> {
  try {
    const t0 = Date.now();
    const res = await fetch("/api/time", { cache: "no-store" });
    const t1 = Date.now();
    const { now } = (await res.json()) as { now: number };
    return now + (t1 - t0) / 2 - t1; // bù nửa thời gian khứ hồi
  } catch {
    return null;
  }
}

export function ClockProvider({ children }: { children: React.ReactNode }) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let alive = true;
    const sync = () =>
      void measureOffset().then((o) => {
        if (alive && o != null) setOffset(o);
      });
    sync();
    const onVisible = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return <ClockContext.Provider value={offset}>{children}</ClockContext.Provider>;
}

/** Thời điểm hiện tại (đã bù lệch), cập nhật mỗi `intervalMs`. */
export function useServerNow(intervalMs = 1000): number {
  const offset = useContext(ClockContext);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now + offset;
}

export function Elapsed({ since, className }: { since: string | null | undefined; className?: string }) {
  const now = useServerNow();
  const seconds = since ? Math.max(0, (now - new Date(since).getTime()) / 1000) : null;
  return (
    <span className={className} suppressHydrationWarning>
      {formatDuration(seconds)}
    </span>
  );
}
