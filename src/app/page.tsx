import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { ROLE_HOME } from "@/lib/types";

export default async function Home() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!session.profile) redirect("/login?error=no-profile");
  redirect(ROLE_HOME[session.profile.role]);
}
