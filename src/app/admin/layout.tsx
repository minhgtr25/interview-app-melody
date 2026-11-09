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
      <div className="min-h-dvh bg-muted/30">
        <AppHeader title="Ban Tổ Chức · Quản trị" subtitle={profile.full_name || profile.email} />
        <AdminNav activeDay={dayState?.day ?? null} />
        <main className="mx-auto max-w-screen-2xl px-4 py-6">{children}</main>
      </div>
    </ClockProvider>
  );
}
