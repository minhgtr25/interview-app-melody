"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";
import { todayInVietnam } from "@/lib/interview-days";

export function useInterviewDayAutoSwitch(activeDay: string | null | undefined) {
  const router = useRouter();
  const notifiedDay = useRef("");
  const refreshedDay = useRef("");
  useEffect(() => {
    let live = true;
    const sync = async () => {
      if (document.visibilityState !== "visible") return;
      const { data, error } = await createClient().rpc("ensure_interview_day");
      if (!live) return;
      const today = todayInVietnam();
      if (error) {
        if (activeDay && activeDay < today && notifiedDay.current !== today) {
          notifiedDay.current = today;
          toast.error(`Chưa chuyển được sang ngày ${today.split("-").reverse().join("/")}`, {
            description: errorMessage(error), duration: 12000,
          });
        }
        return;
      }
      if (typeof data === "string" && activeDay && data !== activeDay && refreshedDay.current !== data) {
        refreshedDay.current = data;
        router.refresh();
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [activeDay, router]);
}
