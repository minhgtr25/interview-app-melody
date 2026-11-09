"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, UserCog, DoorOpen, ListChecks, ExternalLink, ClipboardList, KeyRound, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient, prepareRealtime } from "@/lib/supabase/client";

const ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/candidates", label: "Thí sinh & Excel", icon: Users },
  { href: "/admin/requests", label: "Yêu cầu", icon: CalendarClock },
  { href: "/operations", label: "Tra cứu & lịch sử", icon: ClipboardList },
  { href: "/admin/accounts", label: "Tài khoản", icon: UserCog },
  { href: "/admin/rooms", label: "Phòng & Bàn", icon: DoorOpen },
  { href: "/admin/rubric", label: "Tiêu chí chấm", icon: ListChecks },
  { href: "/admin/reviews", label: "Chốt kết quả", icon: KeyRound },
];

const SHORTCUTS = [
  { href: "/checkin", label: "Màn Check-in" },
  { href: "/coordinator", label: "Màn Điều phối" },
];

export function AdminNav() {
  const pathname = usePathname();
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
  return (
    <nav className="border-b bg-background">
      <div className="mx-auto flex max-w-screen-2xl items-center gap-1 overflow-x-auto px-4">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              {label}
              {href === "/admin/requests" && pendingRequests > 0 && <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white" aria-label={`${pendingRequests} yêu cầu chưa xử lý`}>{pendingRequests}</span>}
            </Link>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-4">
          {SHORTCUTS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              target="_blank"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {s.label}
              <ExternalLink className="size-3" />
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
