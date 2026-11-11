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
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-muted/50 px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 size-[32rem] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />
      <div className="relative w-full max-w-md">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
            <Clapperboard className="size-7" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">CLB Casting</h1>
            <p className="text-sm text-muted-foreground">Đăng nhập bằng tài khoản BTC cấp cho bạn</p>
          </div>
        </div>
        <div className="app-panel p-6 sm:p-8">
          <LoginForm initialError={initialError} />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Không có chức năng tự đăng ký. Quên mật khẩu? Liên hệ Admin.
        </p>
      </div>
    </main>
  );
}
