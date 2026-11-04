import { requireRole } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { AdminNav } from "./admin-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireRole(["ADMIN"]);
  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader title="Ban Tổ Chức · Quản trị" subtitle={profile.full_name || profile.email} />
      <AdminNav />
      <main className="mx-auto max-w-screen-2xl px-4 py-6">{children}</main>
    </div>
  );
}
