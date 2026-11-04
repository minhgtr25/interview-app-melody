"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isDepartmentCode } from "@/lib/departments";
import { hashReviewCode, signReviewSession } from "@/lib/reviews/crypto";
import { getReviewPortal, hasReviewAccess, reviewCookieName } from "@/lib/reviews/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { ReviewDecisionValue } from "@/lib/types";

type Result = { ok: true } | { ok: false; error: string };

export async function unlockReviewPortal(departmentValue: string, codeValue: string): Promise<Result> {
  try {
    if (!isDepartmentCode(departmentValue)) return { ok: false, error: "Đường link Ban không hợp lệ" };
    const portal = await getReviewPortal(departmentValue);
    if (!portal?.active) return { ok: false, error: "Admin chưa mở cổng chấm của Ban này" };
    const code = codeValue.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return { ok: false, error: "Nhập mã gồm đúng 4 chữ hoặc số" };
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error("Thiếu khóa hệ thống");
    const { data, error } = await createServiceClient().rpc("verify_review_portal", {
      p_department: departmentValue,
      p_code_hash: hashReviewCode(departmentValue, portal.generation, code, secret),
    });
    if (error) throw error;
    if (!data) return { ok: false, error: "Mã không đúng hoặc đang tạm khóa sau nhiều lần thử. Hãy chờ 5 phút." };
    const cookieStore = await cookies();
    cookieStore.set(reviewCookieName(departmentValue), signReviewSession({
      department: departmentValue, generation: data as string, expires: Date.now() + 12 * 60 * 60 * 1000,
    }, secret), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
      path: `/review/${departmentValue}`, maxAge: 12 * 60 * 60,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Không kiểm tra được mã" };
  }
}

export async function saveReviewDecision(departmentValue: string, candidateId: string,
  decision: ReviewDecisionValue, noteValue: string): Promise<Result> {
  try {
    if (!isDepartmentCode(departmentValue)) return { ok: false, error: "Ban không hợp lệ" };
    if (!["PASS", "FAIL", "CONSIDER"].includes(decision)) return { ok: false, error: "Quyết định không hợp lệ" };
    const note = noteValue.trim();
    if (note.length > 2000) return { ok: false, error: "Ghi chú tối đa 2.000 ký tự" };
    const portal = await getReviewPortal(departmentValue);
    if (!await hasReviewAccess(departmentValue, portal) || !portal) return { ok: false, error: "Phiên chấm đã hết hạn hoặc Admin đã đóng cổng" };
    const admin = createServiceClient();
    const { data: candidate, error: candidateError } = await admin.from("candidates")
      .select("id").eq("id", candidateId).eq("department", departmentValue).eq("status", "COMPLETED").maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) return { ok: false, error: "Thí sinh chưa hoàn thành phỏng vấn hoặc không thuộc Ban này" };
    const { error } = await admin.from("review_decisions").upsert({
      candidate_id: candidateId, department: departmentValue, decision, note,
      portal_generation: portal.generation, decided_at: new Date().toISOString(),
    }, { onConflict: "candidate_id" });
    if (error) throw error;
    revalidatePath(`/review/${departmentValue}`);
    revalidatePath("/admin/reviews");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Không lưu được quyết định" };
  }
}

export async function leaveReviewPortal(departmentValue: string): Promise<Result> {
  if (!isDepartmentCode(departmentValue)) return { ok: false, error: "Ban không hợp lệ" };
  (await cookies()).set(reviewCookieName(departmentValue), "", { path: `/review/${departmentValue}`, maxAge: 0 });
  return { ok: true };
}
