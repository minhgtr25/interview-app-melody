"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, UserCog, DoorOpen, ListChecks, ExternalLink, ClipboardList, KeyRound, CalendarClock, ClipboardCheck, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { useInterviewDayAutoSwitch } from "@/hooks/use-interview-day-auto-switch";

const GROUPS = [
  { title: "Vận hành", items: [
    { href: "/admin", label: "Tổng quan", icon: LayoutDashboard },
    { href: "/admin/candidates", label: "Thí sinh & Excel", icon: Users },
    { href: "/admin/requests", label: "Yêu cầu", icon: CalendarClock },
    { href: "/operations", label: "Tra cứu & lịch sử", icon: ClipboardList },
  ] },
  { title: "Thiết lập", items: [
    { href: "/admin/accounts", label: "Tài khoản", icon: UserCog },
    { href: "/admin/rooms", label: "Phòng & bàn", icon: DoorOpen },
    { href: "/admin/rubric", label: "Tiêu chí chấm", icon: ListChecks },
    { href: "/admin/reviews", label: "Chốt kết quả", icon: KeyRound },
  ] },
] as const;

const SHORTCUTS = [
  { href: "/checkin", label: "Màn Check-in", icon: ClipboardCheck },
  { href: "/coordinator", label: "Màn Điều phối", icon: Workflow },
] as const;

export function AdminNav({ activeDay }: { activeDay: string | null }) {
  const pathname = usePathname();
  useInterviewDayAutoSwitch(activeDay);
  const [pendingRequests, setPendingRequests] = useState(0);
  useEffect(() => {
    let active = true;
    const client = createClient();
    const refresh = async () => {
      const { count, error } = await client.from("schedule_requests").select("id", { count: "exact", head: true }).eq("status", "PENDING");
      if (active && !error) setPendingRequests(count ?? 0);
    };
    void refresh();
    let channel: ReturnType<typeof client.channel> | null = null;
    void prepareRealtime().then(() => {
      if (!active) return;
      channel = client.channel("admin-schedule-requests").on("postgres_changes",
        { event: "*", schema: "public", table: "schedule_requests" }, () => void refresh()).subscribe();
    }).catch(() => {});
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); if (channel) void client.removeChannel(channel); };
  }, []);

  function item(href: string, label: string, Icon: typeof LayoutDashboard, mobile: boolean) {
    const selected = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
    return <Link key={href} href={href} aria-current={selected ? "page" : undefined}
      className={cn("inline-flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary",
        mobile ? "shrink-0 px-3 py-2" : "w-full px-3 py-2.5",
        selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      {href === "/admin/requests" && pendingRequests > 0 && <span className="ml-auto min-w-5 rounded-full bg-red-600 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white" aria-label={pendingRequests + " yêu cầu chưa xử lý"}>{pendingRequests}</span>}
    </Link>;
  }

  return <>
    <nav aria-label="Điều hướng quản trị" className="border-b bg-background lg:hidden">
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {GROUPS.flatMap((group) => group.items.map(({ href, label, icon }) => item(href, label, icon, true)))}
      </div>
    </nav>
    <aside className="hidden w-56 shrink-0 lg:block">
      <nav aria-label="Điều hướng quản trị" className="sticky top-20 space-y-6">
        {GROUPS.map((group) => <div key={group.title} className="space-y-1">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{group.title}</p>
          {group.items.map(({ href, label, icon }) => item(href, label, icon, false))}
        </div>)}
        <div className="space-y-1 border-t pt-5">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Mở màn khác</p>
          {SHORTCUTS.map(({ href, label, icon: Icon }) => <Link key={href} href={href} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon className="size-4" />{label}<ExternalLink className="ml-auto size-3.5" />
          </Link>)}
        </div>
      </nav>
    </aside>
    <div className="flex flex-wrap gap-2 border-b bg-background px-4 py-2 lg:hidden">
      {SHORTCUTS.map(({ href, label }) => <Link key={href} href={href} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{label}<ExternalLink className="size-3" /></Link>)}
    </div>
  </>;
}
