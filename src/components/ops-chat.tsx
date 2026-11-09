"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";
import type { OpsMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

function mergeMessages(previous: OpsMessage[], incoming: OpsMessage[]) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-100);
}

export function OpsChat({ tableId, selfId, role, candidateId }: {
  tableId: string;
  selfId: string;
  role: "interviewer" | "coordinator" | "support";
  candidateId?: string;
}) {
  const [messages, setMessages] = useState<OpsMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [connected, setConnected] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setConnected(false);
    const client = createClient();
    const load = async () => {
      let query = client.from("ops_messages").select("*");
      query = candidateId ? query.eq("candidate_id", candidateId) : query.eq("table_id", tableId).is("candidate_id", null);
      const { data, error } = await query
        .order("created_at", { ascending: false }).limit(100);
      if (!active) return;
      setLoading(false);
      setLoadError(!!error);
      if (!error) setMessages((current) => mergeMessages(current, (data ?? []) as OpsMessage[]));
    };
    void load();
    let channel: RealtimeChannel | null = null;
    void prepareRealtime().then(() => {
      if (!active) return;
      channel = client.channel(`chat:${candidateId ?? tableId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ops_messages", filter: candidateId ? `candidate_id=eq.${candidateId}` : `table_id=eq.${tableId}` },
        (payload: RealtimePostgresChangesPayload<OpsMessage>) => setMessages((current) => mergeMessages(current, [payload.new as OpsMessage])))
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") { setConnected(true); void load(); }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setConnected(false);
      });
    }).catch(() => { if (active) setConnected(false); });
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; window.clearInterval(poll); if (channel) void client.removeChannel(channel); };
  }, [tableId, candidateId, retryKey]);

  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages.length]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const { data, error } = await createClient().from("ops_messages").insert({
      table_id: tableId, candidate_id: candidateId ?? null, sender_id: selfId, kind: "CHAT", body,
    }).select("*").single();
    setSending(false);
    if (error) return toast.error(errorMessage(error));
    if (data) setMessages((current) => mergeMessages(current, [data as OpsMessage]));
    setDraft("");
  }

  return <div className="space-y-3">
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>{connected ? "Đang kết nối trực tiếp" : "Đang kết nối lại"}</span>
      {loadError && <button type="button" className="font-medium text-primary underline" onClick={() => { setLoading(true); setLoadError(false); setRetryKey((value) => value + 1); }}>Tải lại</button>}
    </div>
    <div ref={scrollRef} className="max-h-80 min-h-48 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-3" aria-live="polite">
      {loadError && <p className="py-8 text-center text-sm text-destructive">Không tải được tin nhắn. Kiểm tra kết nối rồi bấm Tải lại.</p>}
      {loading && messages.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Đang tải tin nhắn…</p>}
      {!loading && !loadError && messages.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">Chưa có tin nhắn.</p>}
      {messages.map((message) => {
        const mine = message.sender_id === selfId;
        const fallback = mine ? role === "interviewer" ? "Giám khảo" : role === "support" ? "Support IT" : "Điều phối"
          : role === "interviewer" ? candidateId ? "Giám khảo" : "Điều phối" : "Giám khảo";
        const label = message.kind === "ALARM" ? "Alarm" : message.sender_label || fallback;
        return <div key={message.id} className={cn("max-w-[90%] rounded-lg border bg-background px-3 py-2 text-sm", mine && "ml-auto border-primary/40 bg-primary/5")}>
          <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
            <span className="font-semibold">{label}</span>
            <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
          </div>
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>;
      })}
    </div>
    <form onSubmit={send} className="flex gap-2">
      <Input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={sending} maxLength={1000}
        placeholder="Nhắn cho điều phối / giám khảo…" aria-label="Nội dung tin nhắn" />
      <Button type="submit" disabled={sending || !draft.trim()} aria-label="Gửi tin nhắn"><Send /></Button>
    </form>
  </div>;
}
