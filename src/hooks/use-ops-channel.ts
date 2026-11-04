"use client";

import { useCallback, useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/** Tin nhắn tức thời giữa giám khảo và điều phối (Supabase Realtime broadcast, không ghi DB). */
export type OpsMessage = {
  type: "CALL_COORDINATOR";
  tableId: string;
  tableLabel: string;
  from: string;
  reason: string;
  at: number;
};

const CHANNEL = "ops";

export function useOpsChannel(onMessage?: (msg: OpsMessage) => void) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    // Kênh private cần JWT của người dùng trước khi join (RLS trên realtime.messages)
    void supabase.auth.getSession().then(async ({ data }: { data: { session: { access_token: string } | null } }) => {
      if (cancelled) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel = supabase
        .channel(CHANNEL, { config: { private: true, broadcast: { self: false, ack: true } } })
        .on("broadcast", { event: "ops" }, (msg: { payload: unknown }) =>
          handlerRef.current?.(msg.payload as OpsMessage)
        )
        .subscribe();
      channelRef.current = channel;
    });

    return () => {
      cancelled = true;
      channelRef.current = null;
      if (channel) void supabase.removeChannel(channel);
    };
  }, []);

  const send = useCallback(async (msg: Omit<OpsMessage, "at">) => {
    const ch = channelRef.current;
    if (!ch) return false;
    const res = await ch.send({ type: "broadcast", event: "ops", payload: { ...msg, at: Date.now() } });
    return res === "ok";
  }, []);

  return { send };
}
