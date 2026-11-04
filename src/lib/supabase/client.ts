import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | undefined;

/** Singleton browser client: dùng chung 1 kết nối realtime cho cả tab. */
export function createClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return client;
}

/** Supply the signed-in JWT before joining Realtime channels protected by RLS. */
export async function prepareRealtime() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) await supabase.realtime.setAuth(session.access_token);
  return supabase;
}
