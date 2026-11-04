import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminSdkClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Profile } from "@/lib/types";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Gọi từ Server Component: middleware sẽ lo refresh cookie.
          }
        },
      },
    }
  );
}

/**
 * Client dùng SERVICE ROLE KEY - bỏ qua RLS. Chỉ dùng trong Server Actions
 * sau khi đã xác thực người gọi là ADMIN. Không bao giờ import vào client.
 */
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Thiếu biến môi trường SUPABASE_SERVICE_ROLE_KEY");
  return createAdminSdkClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Lấy user + profile hiện tại (null nếu chưa đăng nhập hoặc chưa có profile). */
export const getSessionProfile = cache(async (): Promise<{ userId: string; profile: Profile | null } | null> => {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  const claims = authData?.claims;
  if (!claims?.sub) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", claims.sub).maybeSingle();
  return { userId: claims.sub, profile: (data as Profile | null) ?? null };
});
