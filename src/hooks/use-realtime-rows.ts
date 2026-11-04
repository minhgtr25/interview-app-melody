"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { fetchAll } from "@/lib/fetch-all";

export type RealtimeStatus = "connecting" | "live" | "offline";

type Row = { id: string };

/**
 * Giữ một bảng Supabase đồng bộ realtime ở client.
 * - Nhận INSERT/UPDATE/DELETE qua `postgres_changes`.
 * - Tự refetch toàn bộ khi kết nối lại hoặc khi tab được mở lại
 *   (iPad/điện thoại hay ngủ màn hình làm rớt socket), nên không bỏ lỡ sự kiện.
 */
export function useRealtimeRows<T extends Row>(
  table: string,
  initial: T[],
  orderBy: string = "created_at"
) {
  const [rows, setRows] = useState<T[]>(initial);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const hadErrorRef = useRef(false);

  const refetch = useCallback(async () => {
    try {
      const data = await fetchAll<T>(createClient(), table, orderBy);
      setRows(data);
    } catch {
      // giữ dữ liệu cũ, lần kết nối sau sẽ thử lại
    }
  }, [table, orderBy]);

  /** Cập nhật lạc quan trước khi realtime trả về. */
  const patchRow = useCallback((id: string, patch: Partial<T>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    const subscribe = () => {
      if (cancelled) return;
      channel = supabase
      .channel(`rt:${table}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload: RealtimePostgresChangesPayload<T>) => {
          setRows((prev) => {
            if (payload.eventType === "DELETE") {
              const oldId = (payload.old as Partial<T>).id;
              return prev.filter((r) => r.id !== oldId);
            }
            const next = payload.new as T;
            const idx = prev.findIndex((r) => r.id === next.id);
            if (idx === -1) return [...prev, next];
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
          });
        }
      )
      .subscribe((s: string) => {
        if (s === "SUBSCRIBED") {
          setStatus("live");
          if (hadErrorRef.current) {
            hadErrorRef.current = false;
            void refetch();
          }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          hadErrorRef.current = true;
          setStatus("offline");
        }
      });
    };
    void prepareRealtime().then(subscribe).catch(() => {
      if (!cancelled) { hadErrorRef.current = true; setStatus("offline"); }
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const onOnline = () => void refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [table, refetch]);

  return { rows, setRows, patchRow, status, refetch };
}
