"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, UserCog, DoorOpen, ListChecks, ExternalLink, ClipboardList, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/candidates", label: "Thí sinh & Excel", icon: Users },
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
