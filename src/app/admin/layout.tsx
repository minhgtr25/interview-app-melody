import { requireRole } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { ClockProvider } from "@/components/clock";
import { AdminNav } from "./admin-nav";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireRole(["ADMIN"]);
  const supabase = await createClient();
  const { data: dayState } = await supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle();
  return (
    <ClockProvider>
      <div className="min-h-dvh bg-muted/20">
        <AppHeader title="Ban Tổ Chức · Quản trị" subtitle={`${profile.role === "SUPPORT_IT" ? "Support IT" : "Admin"} · ${profile.full_name || profile.email}`} />
        <div className="mx-auto max-w-[1600px] lg:flex lg:gap-8 lg:px-6 lg:py-8">
          <AdminNav activeDay={dayState?.day ?? null} />
          <main id="main-content" className="min-w-0 flex-1 px-4 py-6 lg:px-0 lg:py-0">{children}</main>
        </div>
      </div>
    </ClockProvider>
  );
}
