import { redirect } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { getSessionProfile } from "@/lib/supabase/server";
import { ROLE_HOME } from "@/lib/types";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSessionProfile();
  if (session?.profile) redirect(ROLE_HOME[session.profile.role]);

  const { error } = await searchParams;
  const initialError =
    error === "no-profile" ? "Tài khoản chưa được BTC phân quyền. Liên hệ Admin." : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Clapperboard className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">CLB Casting</h1>
            <p className="text-sm text-muted-foreground">Đăng nhập bằng tài khoản BTC cấp cho bạn</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <LoginForm initialError={initialError} />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Không có chức năng tự đăng ký. Quên mật khẩu? Liên hệ Admin.
        </p>
      </div>
    </main>
  );
}
