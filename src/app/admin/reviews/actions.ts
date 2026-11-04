"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isDepartmentCode, type DepartmentCode } from "@/lib/departments";
import { generateReviewCode, hashReviewCode } from "@/lib/reviews/crypto";
import { createServiceClient, getSessionProfile } from "@/lib/supabase/server";

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function requireAdmin() {
  const session = await getSessionProfile();
  if (session?.profile?.role !== "ADMIN") throw new Error("Chỉ Admin được quản lý link chấm kết quả");
}

export async function openReviewPortal(value: string): Promise<Result<{ department: DepartmentCode; code: string }>> {
  try {
    await requireAdmin();
    if (!isDepartmentCode(value)) throw new Error("Ban không hợp lệ");
    const generation = randomUUID();
    const code = generateReviewCode();
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("Thiếu SUPABASE_SERVICE_ROLE_KEY");
    const admin = createServiceClient();
    const { error } = await admin.from("review_portals").upsert({
      department: value, active: true, code_hash: hashReviewCode(value, generation, code, secret),
      generation, failed_attempts: 0, locked_until: null,
      opened_at: new Date().toISOString(), closed_at: null,
    }, { onConflict: "department" });
    if (error) throw error;
    revalidatePath("/admin/reviews");
    revalidatePath(`/review/${value}`);
    return { ok: true, data: { department: value, code } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Không mở được cổng chấm" };
  }
}

export async function closeReviewPortal(value: string): Promise<Result> {
  try {
    await requireAdmin();
    if (!isDepartmentCode(value)) throw new Error("Ban không hợp lệ");
    const { error } = await createServiceClient().from("review_portals")
      .update({ active: false, generation: randomUUID(), closed_at: new Date().toISOString() })
      .eq("department", value);
    if (error) throw error;
    revalidatePath("/admin/reviews");
    revalidatePath(`/review/${value}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Không đóng được cổng chấm" };
  }
}
