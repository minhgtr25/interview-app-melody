"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient, getSessionProfile } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";
import { normalizeDepartment } from "@/lib/departments";
import { normalizeGender, normalizeStudentNumber } from "@/lib/personal-info";
import { isSpecializationForDepartment } from "@/lib/specializations";
import { errorMessage } from "@/lib/format";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const ROLES: UserRole[] = ["ADMIN", "SUPPORT_IT", "CHECKIN", "COORDINATOR", "INTERVIEWER"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mọi server action admin phải qua đây: xác thực lại phía server, không tin client. */
async function assertAdmin() {
  const session = await getSessionProfile();
  if (!session?.profile || !["ADMIN", "SUPPORT_IT"].includes(session.profile.role)) {
    throw new Error("Chỉ Admin hoặc Support IT mới được thực hiện thao tác này");
  }
  return session.profile;
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: errorMessage(err) };
}

function validatePassword(pw: string) {
  if (pw.length < 8) throw new Error("Mật khẩu tối thiểu 8 ký tự");
}

function generateTablePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*?"];
  const pick = (chars: string) => chars[randomInt(chars.length)];
  const characters = [pick(groups[0]), pick(groups[1]), pick(groups[2]), pick(groups[3])];
  const all = groups.join("");
  while (characters.length < 8) characters.push(pick(all));
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }
  return characters.join("");
}

function interviewerEmail(roomName: string, tableName: string) {
  const localPart = `${roomName}-${tableName}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!localPart) throw new Error("Không tạo được email từ tên phòng và bàn");
  return `${localPart}@club.local`;
}

export async function createTableAccount(tableId: string): Promise<ActionResult<{ id: string; email: string; password: string }>> {
  try {
    await assertAdmin();
    const admin = createServiceClient();
    const { data: table, error: tableError } = await admin.from("tables").select("id, room_id, name").eq("id", tableId).single();
    if (tableError || !table) throw tableError ?? new Error("Không tìm thấy bàn");
    const { data: room, error: roomError } = await admin.from("rooms").select("name,is_challenge").eq("id", table.room_id).single();
    if (roomError || !room) throw roomError ?? new Error("Không tìm thấy phòng");
    const email = interviewerEmail(room.name, table.name);
    const password = generateTablePassword();
    const fullName = `${room.is_challenge ? "Giám khảo thử thách" : "Đại diện"} ${room.name} - ${table.name}`;
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (error || !data.user) throw error ?? new Error("Không tạo được tài khoản");
    const { error: profileError } = await admin.from("profiles").upsert({
      id: data.user.id, email, full_name: fullName, role: "INTERVIEWER", table_id: table.id,
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      throw profileError;
    }
    revalidatePath("/admin/rooms");
    revalidatePath("/admin/accounts");
    return { ok: true, data: { id: data.user.id, email, password } };
  } catch (error) {
    return fail(error);
  }
}

/** Gán tài khoản đại diện qua service role vì RLS không cho client sửa profiles. */
export async function assignRoomTableAccounts(
  roomId: string,
  assignments: { tableId: string; profileId: string }[],
  replaceExisting: boolean,
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const admin = createServiceClient();
    const { data: roomTables, error: tableError } = await admin.from("tables")
      .select("id").eq("room_id", roomId);
    if (tableError) throw tableError;
    const tableIds = (roomTables ?? []).map((table) => table.id);
    if (!tableIds.length) throw new Error("Phòng chưa có bàn");
    const validTableIds = new Set(tableIds);
    const profileIds = assignments.map((item) => item.profileId);
    if (assignments.some((item) => !validTableIds.has(item.tableId)) ||
      new Set(assignments.map((item) => item.tableId)).size !== assignments.length ||
      new Set(profileIds).size !== profileIds.length) {
      throw new Error("Danh sách tài khoản đại diện không hợp lệ");
    }

    const { data: current, error: currentError } = await admin.from("profiles")
      .select("id,table_id").eq("role", "INTERVIEWER").in("table_id", tableIds);
    if (currentError) throw currentError;
    const { data: selected, error: selectedError } = profileIds.length
      ? await admin.from("profiles").select("id,role,table_id").in("id", profileIds)
      : { data: [], error: null };
    if (selectedError) throw selectedError;
    if ((selected ?? []).length !== profileIds.length || (selected ?? []).some((profile) =>
      profile.role !== "INTERVIEWER" || (profile.table_id && !validTableIds.has(profile.table_id)))) {
      throw new Error("Tài khoản Giám khảo không hợp lệ hoặc đang thuộc phòng khác");
    }
    if (!replaceExisting && assignments.some((item) => {
      const profile = (selected ?? []).find((row) => row.id === item.profileId);
      return profile?.table_id && profile.table_id !== item.tableId;
    })) {
      throw new Error("Tài khoản này đang đại diện bàn khác; chọn tài khoản chưa gán bàn");
    }
    if (!replaceExisting && assignments.some((item) => (current ?? []).some((profile) => profile.table_id === item.tableId && profile.id !== item.profileId))) {
      throw new Error("Bàn đã có tài khoản đại diện");
    }

    try {
      if (replaceExisting && (current ?? []).length) {
        const { error } = await admin.from("profiles").update({ table_id: null })
          .eq("role", "INTERVIEWER").in("table_id", tableIds);
        if (error) throw error;
      }
      for (const item of assignments) {
        const { error } = await admin.from("profiles").update({ table_id: item.tableId })
          .eq("id", item.profileId).eq("role", "INTERVIEWER");
        if (error) throw error;
      }
    } catch (error) {
      if (profileIds.length) await admin.from("profiles").update({ table_id: null }).in("id", profileIds);
      if (replaceExisting) for (const profile of current ?? []) {
        await admin.from("profiles").update({ table_id: profile.table_id }).eq("id", profile.id);
      }
      throw error;
    }
    revalidatePath("/admin/rooms");
    revalidatePath("/admin/accounts");
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Tài khoản
// ---------------------------------------------------------------------------
export async function createAccount(input: {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  tableId: string | null;
}): Promise<ActionResult<{ email: string; password: string }>> {
  try {
    await assertAdmin();
    if (!ROLES.includes(input.role)) throw new Error("Vai trò không hợp lệ");
    validatePassword(input.password);
    const tableId = input.role === "INTERVIEWER" ? input.tableId || null : null;

    const admin = createServiceClient();
    let email = input.email.trim().toLowerCase();
    if (input.role === "INTERVIEWER") {
      if (!tableId) throw new Error("Chọn bàn để tạo tài khoản Giám khảo");
      if (input.password.length !== 8) throw new Error("Mật khẩu Giám khảo phải đúng 8 ký tự");
      const { data: table, error: tableError } = await admin.from("tables").select("id,room_id,name").eq("id", tableId).single();
      if (tableError || !table) throw tableError ?? new Error("Không tìm thấy bàn");
      const { data: room, error: roomError } = await admin.from("rooms").select("name").eq("id", table.room_id).single();
      if (roomError || !room) throw roomError ?? new Error("Không tìm thấy phòng");
      const { data: assigned } = await admin.from("profiles").select("id").eq("role", "INTERVIEWER").eq("table_id", tableId).limit(1);
      if (assigned?.length) throw new Error("Bàn này đã có tài khoản Giám khảo");
      email = interviewerEmail(room.name, table.name);
    } else if (!EMAIL_RE.test(email)) {
      throw new Error("Email không hợp lệ");
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName.trim() },
    });
    if (error) {
      if (/already/i.test(error.message)) throw new Error("Email này đã có tài khoản");
      throw error;
    }

    const { error: pErr } = await admin.from("profiles").upsert({
      id: data.user.id,
      email,
      full_name: input.fullName.trim(),
      role: input.role,
      table_id: tableId,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(data.user.id); // rollback
      throw pErr;
    }
    revalidatePath("/admin/accounts");
    return { ok: true, data: { email, password: input.password } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateAccount(input: {
  id: string;
  fullName: string;
  role: UserRole;
  tableId: string | null;
}): Promise<ActionResult> {
  try {
    const me = await assertAdmin();
    if (!ROLES.includes(input.role)) throw new Error("Vai trò không hợp lệ");
    if (input.id === me.id && !["ADMIN", "SUPPORT_IT"].includes(input.role)) {
      throw new Error("Không thể tự hạ quyền Admin của chính mình");
    }
    const admin = createServiceClient();
    const { error } = await admin
      .from("profiles")
      .update({
        full_name: input.fullName.trim(),
        role: input.role,
        table_id: input.role === "INTERVIEWER" ? input.tableId || null : null,
      })
      .eq("id", input.id);
    if (error) throw error;
    revalidatePath("/admin/accounts");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function resetPassword(id: string, password: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    validatePassword(password);
    const admin = createServiceClient();
    const { data: profile } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
    if (profile?.role === "INTERVIEWER" && password.length !== 8) throw new Error("Mật khẩu Giám khảo phải đúng 8 ký tự");
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAllInterviewerAccounts(): Promise<ActionResult<{ deleted: number; failed: number }>> {
  try {
    await assertAdmin();
    const admin = createServiceClient();
    const { data: occupied, error: tableError } = await admin.from("tables").select("id").neq("status", "AVAILABLE").limit(1);
    if (tableError) throw tableError;
    if (occupied?.length) throw new Error("Giải phóng các bàn đang có thí sinh trước khi xóa tài khoản Giám khảo");

    const { data: interviewers, error } = await admin.from("profiles").select("id").eq("role", "INTERVIEWER");
    if (error) throw error;
    let deleted = 0;
    let failed = 0;
    for (const interviewer of interviewers ?? []) {
      const result = await admin.auth.admin.deleteUser(interviewer.id);
      if (result.error) failed++;
      else deleted++;
    }
    revalidatePath("/admin/accounts");
    revalidatePath("/admin/rooms");
    if (failed && !deleted) throw new Error(`Không xóa được tài khoản nào; ${failed} tài khoản gặp lỗi`);
    return { ok: true, data: { deleted, failed } };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAccount(id: string): Promise<ActionResult> {
  try {
    const me = await assertAdmin();
    if (id === me.id) throw new Error("Không thể tự xoá tài khoản của chính mình");
    const { error } = await createServiceClient().auth.admin.deleteUser(id);
    if (error) throw error;
    revalidatePath("/admin/accounts");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Thí sinh (dùng client của user; RLS cho phép ADMIN ghi)
// ---------------------------------------------------------------------------
export type CandidateInput = {
  code: string;
  full_name: string;
  student_number: string | null;
  student_number_raw?: string | null;
  student_cohort: string | null;
  gender: string | null;
  facebook_url: string | null;
  phone: string | null;
  email: string | null;
  department: string | null;
  specialization: string | null;
  shift: string | null;
  cv_url: string | null;
};

function cleanCandidate(c: CandidateInput): CandidateInput {
  const t = (v: string | null | undefined, max = 500) => {
    const s = (v ?? "").toString().trim().slice(0, max);
    return s || null;
  };
  const code = t(c.code, 64);
  const name = t(c.full_name, 200);
  if (!code) throw new Error("Thiếu mã ứng viên");
  if (!name) throw new Error(`Thiếu họ tên (mã ${code})`);
  const department = t(c.department, 120);
  const normalizedDepartment = normalizeDepartment(department);
  const specialization = t(c.specialization, 32) ?? (department && /^(DE|DESIGN|BAN DESIGN)$/i.test(department) ? "DESIGN" : null);
  if (specialization && !isSpecializationForDepartment(normalizedDepartment, specialization)) throw new Error("Ngạch không khớp với Ban ứng tuyển");
  if (!normalizedDepartment) throw new Error(`Ban không hợp lệ (mã ${code}). Chọn CM, VH, TT, ND hoặc HCTC`);
  const rawStudentNumber = t(c.student_number, 32);
  const studentNumber = rawStudentNumber ? normalizeStudentNumber(rawStudentNumber) : null;
  if (rawStudentNumber && !studentNumber) throw new Error(`MSSV phải gồm đúng 8 chữ hoặc số (mã ${code})`);
  const rawGender = t(c.gender, 20);
  const gender = rawGender ? normalizeGender(rawGender) : null;
  if (rawGender && !gender) throw new Error(`Giới tính không hợp lệ (mã ${code})`);
  return {
    code,
    full_name: name,
    student_number: studentNumber,
    student_number_raw: studentNumber ? null : t(c.student_number_raw, 120),
    student_cohort: t(c.student_cohort, 32),
    gender,
    facebook_url: t(c.facebook_url, 2000),
    phone: t(c.phone, 32),
    email: t(c.email, 200)?.toLowerCase() ?? null,
    department: normalizedDepartment,
    specialization,
    shift: t(c.shift, 120),
    cv_url: t(c.cv_url, 2000),
  };
}

export type FormCandidateInput = {
  full_name: string;
  student_number: string;
  student_cohort: string | null;
  gender: string;
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  department: string;
  specialization?: string | null;
};

export async function importSchedules(rows: { student_number: string | null; email: string | null; shift: string }[]): Promise<ActionResult<{ count: number }>> {
  try {
    await assertAdmin();
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) throw new Error("Lịch phải có từ 1 đến 5000 dòng");
    const clean = rows.map((row) => ({
      student_number: String(row.student_number ?? "").trim().toUpperCase(),
      email: String(row.email ?? "").trim().toLowerCase(),
      shift: String(row.shift ?? "").trim(),
    }));
    if (clean.some((row) => (!row.student_number && !row.email) || !row.shift || row.shift.length > 100)) {
      throw new Error("Có dòng lịch thiếu thông tin nhận diện hoặc Ca không hợp lệ");
    }
    const client = await createClient();
    // Old database versions concatenate multiple departments into one Ca.
    // Require the new schedule RPC before writing any rows.
    const probe = await client.rpc("update_candidate_schedules", { p_updates: [] });
    if (probe.error?.code === "PGRST202" || probe.error?.code === "42883") {
      throw new Error("Tính năng nhập lịch chưa sẵn sàng trên máy chủ. Hãy liên hệ Support IT.");
    }
    if (probe.error && probe.error.code !== "P0001") throw probe.error;
    const { data, error } = await client.rpc("import_candidate_schedules", { p_rows: clean });
    if (error) {
      if (error.code === "PGRST202") throw new Error("Tính năng nhập lịch chưa sẵn sàng trên máy chủ. Hãy liên hệ Support IT.");
      throw error;
    }
    revalidatePath("/admin/candidates");
    return { ok: true, data: { count: Number(data ?? 0) } };
  } catch (e) {
    return fail(e);
  }
}

/** Ghi toàn bộ file trong một transaction qua RPC; nhập lại theo MSSV. */
export async function importCandidates(rows: FormCandidateInput[]): Promise<ActionResult<{ count: number }>> {
  try {
    await assertAdmin();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("File không có dòng dữ liệu nào");
    if (rows.length > 5000) throw new Error("Tối đa 5000 thí sinh mỗi lần import");
    const seen = new Set<string>();
    const clean = rows.map((row) => {
      const studentNumber = normalizeStudentNumber(row.student_number);
      const gender = normalizeGender(row.gender);
      const department = normalizeDepartment(row.department);
      const specialization = row.specialization?.trim().toUpperCase() || (/^(DE|DESIGN|BAN DESIGN)$/i.test(row.department) ? "DESIGN" : null);
      const name = row.full_name?.trim();
      const identity = studentNumber ?? (row.email ? `EMAIL:${row.email.trim().toLowerCase()}` : null);
      if (!identity) throw new Error("MSSV chưa hợp lệ và thiếu Email để đối chiếu");
      const applicationIdentity = `${identity}|${department ?? ""}`;
      if (seen.has(applicationIdentity)) throw new Error(`Thí sinh trùng trong file: ${identity}`);
      seen.add(applicationIdentity);
      if (!name || name.length > 200) throw new Error(`Họ tên không hợp lệ (${identity})`);
      if (!gender) throw new Error(`Giới tính không hợp lệ (${identity})`);
      if (!department) throw new Error(`Ban không hợp lệ (${identity})`);
      if (specialization && !isSpecializationForDepartment(department, specialization)) throw new Error(`Ngạch không khớp Ban (${identity})`);
      return {
        student_number: studentNumber ?? row.student_number.trim().toUpperCase(),
        full_name: name,
        student_cohort: row.student_cohort?.trim() || null,
        gender,
        phone: row.phone?.trim() || null,
        email: row.email?.trim().toLowerCase() || null,
        facebook_url: row.facebook_url?.trim() || null,
        department,
        specialization,
      };
    });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("import_form_candidates", { p_rows: clean });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42703") {
        throw new Error("Tính năng nhập hồ sơ chưa sẵn sàng trên máy chủ. Hãy liên hệ Support IT.");
      }
      throw error;
    }
    revalidatePath("/admin");
    return { ok: true, data: { count: Number(data ?? 0) } };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCandidate(id: string | null, input: CandidateInput): Promise<ActionResult> {
  try {
    await assertAdmin();
    const c = cleanCandidate(input);
    const supabase = await createClient();
    const { error } = id
      ? await supabase.from("candidates").update(c).eq("id", id)
      : await supabase.from("candidates").insert(c);
    if (error) {
      if (error.code === "23505") throw new Error(error.message?.includes("student_number")
        ? `MSSV "${c.student_number}" đã thuộc thí sinh khác`
        : `Mã ứng viên "${c.code}" đã tồn tại`);
      throw error;
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCandidate(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const supabase = await createClient();
    const { data } = await supabase.from("candidates").select("status,challenge_status").eq("id", id).maybeSingle();
    if (data && ((data.status === "ASSIGNED" || data.status === "INTERVIEWING") || data.challenge_status === "ASSIGNED" || data.challenge_status === "INTERVIEWING")) {
      throw new Error("Thí sinh đang ở bàn. Trả về hàng chờ trước khi xoá.");
    }
    const { data: linked, error: linkedError } = await supabase.from("candidates")
      .select("status,challenge_status").eq("source_candidate_id", id);
    if (linkedError) throw linkedError;
    if (linked?.some((candidate) => candidate.status === "ASSIGNED" || candidate.status === "INTERVIEWING" || candidate.challenge_status === "ASSIGNED" || candidate.challenge_status === "INTERVIEWING")) {
      throw new Error("Thí sinh có hồ sơ lượt hai đang ở bàn. Trả lượt đó về hàng chờ trước khi xoá.");
    }
    const { error } = await supabase.from("candidates").delete().eq("id", id);
    if (error) throw error;
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Xoá toàn bộ thí sinh + đánh giá (bắt đầu đợt tuyển mới). */
export async function deleteAllCandidates(confirmText: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    if (confirmText !== "XOA TAT CA") throw new Error("Chuỗi xác nhận không khớp");
    const supabase = await createClient();
    const { data: busy } = await supabase
      .from("tables")
      .select("id")
      .neq("status", "AVAILABLE")
      .limit(1);
    if (busy && busy.length) throw new Error("Vẫn còn bàn đang có thí sinh. Giải phóng tất cả bàn trước.");
    const { error } = await supabase.from("candidates").delete().not("id", "is", null);
    if (error) throw error;
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
