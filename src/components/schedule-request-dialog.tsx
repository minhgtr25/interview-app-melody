"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ScheduleFields, isFutureInterviewSlot } from "@/components/schedule-fields";
import { useServerNow } from "@/components/clock";
import { makeInterviewShift } from "@/lib/interview-days";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";
import type { Candidate } from "@/lib/types";

export function ScheduleRequestDialog({ candidate, candidates, onClose }: {
  candidate: Candidate | null;
  candidates: Candidate[];
  onClose: () => void;
}) {
  const now = useServerNow(30_000);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDate("");
    setTime("");
    setReason(candidate?.absent_note ?? "");
  }, [candidate]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidate?.department || !isFutureInterviewSlot(date, time, now)) return;
    const proposed = makeInterviewShift(date, time, candidate.department);
    setSaving(true);
    const { error } = await createClient().rpc("request_schedule_change", {
      p_candidate_id: candidate.id, p_proposed_shift: proposed, p_reason: reason,
    });
    setSaving(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Đã gửi yêu cầu đổi lịch cho Admin/Support IT");
    onClose();
  }

  return <Dialog open={candidate !== null} onOpenChange={(open) => !open && !saving && onClose()}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Yêu cầu đổi lịch · {candidate?.full_name}</DialogTitle>
        <DialogDescription>Ca hiện tại: {candidate?.shift || "Chưa có"}. Lịch chỉ thay đổi sau khi Admin/Support IT duyệt.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <ScheduleFields idPrefix="schedule-request" candidates={candidates} department={candidate?.department ?? ""}
          date={date} time={time} onDateChange={setDate} onTimeChange={setTime} />
        <label className="grid gap-1.5 text-sm font-medium">Lý do / ghi chú
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000}
            placeholder="Ví dụ: thí sinh xin chuyển sang ca chiều ngày mai" />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button type="submit" disabled={saving || !isFutureInterviewSlot(date, time, now) || !candidate?.department}>
            {saving && <Loader2 className="animate-spin" />} Gửi yêu cầu
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
