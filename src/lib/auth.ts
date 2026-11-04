import "server-only";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { ROLE_HOME, type Profile, type UserRole } from "@/lib/types";

/** Dùng trong layout/page server: chặn sai vai trò và đưa về đúng trang. */
export async function requireRole(roles: UserRole[]): Promise<Profile> {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!session.profile) redirect("/login?error=no-profile");
  if (!roles.includes(session.profile.role)) redirect(ROLE_HOME[session.profile.role]);
  return session.profile;
}
