"use client";

import { LogOut, Wifi, WifiOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/login/actions";
import type { RealtimeStatus } from "@/hooks/use-realtime-rows";
import { cn } from "@/lib/utils";

export function LiveIndicator({ status }: { status: RealtimeStatus }) {
  const map = {
    live: { icon: Wifi, text: "Realtime", cls: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-300" },
    connecting: { icon: Loader2, text: "Đang kết nối", cls: "text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300" },
    offline: { icon: WifiOff, text: "Mất kết nối", cls: "text-red-700 bg-red-50 dark:bg-red-950 dark:text-red-300" },
  }[status];
  const Icon = map.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", map.cls)}>
      <Icon className={cn("size-3.5", status === "connecting" && "animate-spin")} />
      <span className="hidden sm:inline">{map.text}</span>
    </span>
  );
}

export function AppHeader({
  title,
  mobileTitle,
  subtitle,
  status,
  children,
}: {
  title: string;
  mobileTitle?: string;
  subtitle?: string;
  status?: RealtimeStatus;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-14 max-w-screen-2xl items-center gap-2 px-2 py-2 sm:gap-3 sm:px-4">
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-sm font-semibold leading-tight sm:text-base">
            {mobileTitle ? <><span className="sm:hidden">{mobileTitle}</span><span className="hidden sm:inline">{title}</span></> : title}
          </h1>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
        {status && <LiveIndicator status={status} />}
        <form action={logout}>
          <Button type="submit" variant="ghost" size="sm" aria-label="Đăng xuất">
            <LogOut />
            <span className="hidden sm:inline">Đăng xuất</span>
          </Button>
        </form>
      </div>
    </header>
  );
}
