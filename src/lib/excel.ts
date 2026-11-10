import * as XLSX from "xlsx";
import { normalizeDepartment } from "@/lib/departments";
import { isSpecializationForDepartment, specializationLabel } from "@/lib/specializations";
import { formatDateTime, formatDuration, normalizePhone, normalizeText, safeUrl } from "@/lib/format";
import { GENDERS, normalizeGender, normalizeStudentNumber } from "@/lib/personal-info";
import { dayLabel } from "@/lib/interview-days";
import { createCandidateApplicationStatusResolver } from "@/lib/candidate-application-status";
import { candidateApplicationDay, candidateApplicationNote, candidateApplicationShift } from "@/lib/candidate-application-day";
import {
  STATUS_LABEL,
  type Candidate,
  type Evaluation,
  type RubricCriterion,
} from "@/lib/types";

export type CandidateField = "full_name" | "student_number" | "student_cohort" | "gender" | "phone" | "email" | "facebook_url" | "department" | "specialization";

export const FIELD_LABEL: Record<CandidateField, string> = {
  full_name: "Họ tên",
  student_number: "Mã số sinh viên",
  student_cohort: "Khóa sinh viên",
  gender: "Giới tính",
  phone: "SĐT",
  email: "Email",
  facebook_url: "Link Facebook",
  department: "Ban ứng tuyển",
  specialization: "Ngạch",
};

/** Các tên cột thường gặp (đã bỏ dấu, lowercase) để tự động map. */
const ALIASES: Record<CandidateField, string[]> = {
  full_name: ["ho ten", "ho va ten", "ten", "ten ung vien", "ten thi sinh", "full name", "name", "fullname"],
  student_number: ["ma so sinh vien", "mssv", "student number", "student id"],
  student_cohort: ["sinh vien khoa", "khoa sinh vien", "khoa", "cohort"],
  gender: ["gioi tinh", "gender"],
  phone: ["sdt", "so dien thoai", "dien thoai", "phone", "phone number", "dt", "mobile"],
  email: ["email", "e-mail", "mail", "gmail", "dia chi email"],
  facebook_url: ["link facebook", "facebook", "fb url"],
  department: ["ban dang ky ban nao", "ban ung tuyen", "ban dang ky", "department", "team"],
  specialization: ["ngach", "nhanh", "media design content", "hat nhac cu rap", "chuyen mon nhanh", "truyen thong nhanh", "specialization"],
};

/** Trả về field phù hợp cho từng header (null nếu không nhận ra). Ưu tiên khớp chính xác, rồi khớp chứa. */
export function autoMapHeaders(headers: string[]): (CandidateField | null)[] {
  const norm = headers.map((h) => normalizeText(h));
  const result: (CandidateField | null)[] = headers.map(() => null);
  const used = new Set<CandidateField>();

  const tryAssign = (match: (h: string, alias: string) => boolean) => {
    (Object.keys(ALIASES) as CandidateField[]).forEach((field) => {
      if (used.has(field)) return;
      for (const alias of ALIASES[field]) {
        const idx = norm.findIndex((h, i) => result[i] === null && match(h, alias));
        if (idx !== -1) {
          result[idx] = field;
          used.add(field);
          return;
        }
      }
    });
  };
  tryAssign((h, a) => h === a);
  tryAssign((h, a) => a.length >= 3 && h.includes(a));
  return result;
}

export type ParsedSheet = { headers: string[]; rows: unknown[][]; rowNumbers?: number[]; skippedRed?: number; sheetName: string };

export async function readSpreadsheet(file: File): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true, cellStyles: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("File không có sheet nào");
  const worksheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false, // lấy chuỗi hiển thị (giữ số 0 đầu nếu ô định dạng Text)
    defval: "",
    blankrows: true,
  });
  // Bỏ các dòng trống đầu file, dòng đầu tiên có dữ liệu là header
  const start = matrix.findIndex((r) => r.some((v) => String(v).trim() !== ""));
  if (start === -1) throw new Error("File trống");
  const headers = matrix[start].map((h) => String(h).trim());
  const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1");
  const rows: unknown[][] = [];
  const rowNumbers: number[] = [];
  let skippedRed = 0;
  matrix.slice(start + 1).forEach((r, offset) => {
    if (!r.some((v) => String(v).trim() !== "")) return;
    const rowNumber = range.s.r + start + offset + 2;
    const redCells = Array.from({ length: Math.min(r.length, 8) }, (_, col) => {
      const address = XLSX.utils.encode_cell({ r: rowNumber - 1, c: range.s.c + col });
      return worksheet[address]?.s?.fgColor?.rgb?.toUpperCase().endsWith("FF0000") ? 1 : 0;
    }).reduce<number>((sum, red) => sum + red, 0);
    if (redCells >= 2) { skippedRed++; return; }
    rows.push(r); rowNumbers.push(rowNumber);
  });
  return { headers, rows, rowNumbers, skippedRed, sheetName };
}

export type MappedCandidate = Record<CandidateField, string | null>;

export function applyMapping(sheet: ParsedSheet, mapping: (CandidateField | null)[]) {
  const valid: MappedCandidate[] = [];
  const errors: { row: number; message: string }[] = [];
  const invalidStudentRows: number[] = [];
  sheet.rows.forEach((r, i) => {
    const rec: MappedCandidate = { full_name: null, student_number: null, student_cohort: null, gender: null, phone: null, email: null, facebook_url: null, department: null, specialization: null };
    mapping.forEach((field, col) => {
      if (!field) return;
      const v = String(r[col] ?? "").trim();
      if (v) rec[field] = v;
    });
    rec.phone = normalizePhone(rec.phone);
    const rowNo = sheet.rowNumbers?.[i] ?? i + 2;
    if (!rec.full_name && !rec.student_number && !rec.department && !rec.phone && !rec.email) return;
    if (!rec.full_name) return errors.push({ row: rowNo, message: "Thiếu họ tên" });
    const studentNumber = normalizeStudentNumber(rec.student_number);
    if (!studentNumber) {
      if (!rec.email) return errors.push({ row: rowNo, message: "MSSV chưa hợp lệ và thiếu Email để đối chiếu" });
      invalidStudentRows.push(rowNo);
    }
    rec.student_number = studentNumber ?? rec.student_number;
    const gender = normalizeGender(rec.gender);
    if (!gender) return errors.push({ row: rowNo, message: "Thiếu Giới tính hoặc giá trị không hợp lệ" });
    rec.gender = gender;
    const legacyDesign = ["DE", "DESIGN", "BAN DESIGN"].includes((rec.department ?? "").trim().toUpperCase());
    const department = normalizeDepartment(rec.department);
    if (!department) return errors.push({ row: rowNo, message: "Thiếu Ban hoặc Ban không thuộc CM, VH, TT, ND, HCTC" });
    rec.department = department;
    if (!rec.specialization && legacyDesign) rec.specialization = "DESIGN";
    if (rec.specialization) {
      const code = normalizeText(rec.specialization).toUpperCase().replace(/\s+/g, "_");
      if (!isSpecializationForDepartment(department, code)) return errors.push({ row: rowNo, message: "Ngạch không hợp lệ hoặc không khớp Ban" });
      rec.specialization = code;
    }
    if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) return errors.push({ row: rowNo, message: "Email không hợp lệ" });
    if (rec.facebook_url && !safeUrl(rec.facebook_url)) return errors.push({ row: rowNo, message: "Link Facebook không hợp lệ" });
    valid.push(rec);
  });
  const byIdentity = new Map<string, MappedCandidate>();
  const identityDepartments = new Map<string, Set<string>>();
  const duplicates: string[] = [];
  let mergedDuplicates = 0;
  for (const row of valid) {
    const key = normalizeStudentNumber(row.student_number) ?? `EMAIL:${row.email?.toLowerCase()}`;
    const department = row.department ?? "";
    const applicationKey = `${key}|${department}`;
    const previous = byIdentity.get(applicationKey);
    if (previous) {
      if (normalizeText(previous.full_name ?? "") !== normalizeText(row.full_name ?? "") ||
          (previous.email && row.email && previous.email.toLowerCase() !== row.email.toLowerCase())) {
        duplicates.push(key);
        continue;
      }
      mergedDuplicates++;
    }
    const departments = identityDepartments.get(key) ?? new Set<string>();
    departments.add(department);
    identityDepartments.set(key, departments);
    byIdentity.set(applicationKey, row);
  }
  return { valid: [...byIdentity.values()], errors, duplicates, invalidStudentRows, mergedDuplicates };
}

/** File mẫu để Admin điền danh sách. */
export function downloadTemplate() {
  const fields: CandidateField[] = ["student_number", "full_name", "student_cohort", "gender", "phone", "email", "facebook_url", "department", "specialization"];
  const ws = XLSX.utils.aoa_to_sheet([
    fields.map((field) => FIELD_LABEL[field]),
    ["HE123456", "Nguyễn Văn A", "K22", "Nam", "0901234567", "a.nguyen@example.com", "https://facebook.com/example", "Ban Truyền Thông", "Media"],
  ]);
  ws["!cols"] = [14, 24, 14, 12, 14, 28, 40, 24, 18].map((wch) => ({ wch }));
  // Cột SĐT định dạng Text để Excel không làm mất số 0
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Thi sinh");
  XLSX.writeFile(wb, "mau_danh_sach_thi_sinh.xlsx");
}

/**
 * Xuất kết quả: sheet "Kết quả" (1 dòng / thí sinh, đủ điểm từng tiêu chí)
 * + sheet "Tổng hợp theo ban".
 */
export function exportResults(
  candidates: Candidate[],
  evaluations: Evaluation[],
  criteria: RubricCriterion[],
  filter?: { department?: string; day?: string },
) {
  const allCandidates = candidates;
  const allEvaluations = evaluations;
  const getApplicationStatus = createCandidateApplicationStatusResolver(allCandidates, allEvaluations);
  const allEvaluationByCandidate = new Map(allEvaluations.map((evaluation) => [evaluation.candidate_id, evaluation]));
  if (filter?.department) candidates = candidates.filter((candidate) => candidate.department === filter.department);
  if (filter?.day) candidates = candidates.filter((candidate) => candidateApplicationDay(candidate, allEvaluationByCandidate.get(candidate.id)) === filter.day);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  evaluations = evaluations.filter((evaluation) => candidateIds.has(evaluation.candidate_id));
  const evalBy = new Map(evaluations.map((e) => [e.candidate_id, e]));
  const candidateById = new Map(allCandidates.map((candidate) => [candidate.id, candidate]));
  const crit = [...criteria].sort((a, b) => a.sort_order - b.sort_order);

  const header = [
    "Mã ứng viên", "MSSV", "MSSV cần xác minh", "Lượt phỏng vấn", "Họ tên", "Khóa", "Giới tính", "SĐT", "Email", "Facebook", "Ban ứng tuyển", "Ngạch", "Ngày phỏng vấn", "Ca phỏng vấn", "Trạng thái", "Ghi chú phỏng vấn",
    ...crit.map((c) => `${c.name} (/${c.max_score})`),
    "Điểm TB (/10)", "Nhận xét", "Thời lượng (mm:ss)", "Người chấm", "Phòng - Bàn",
    ...crit.map((c) => `Thử thách · ${c.name} (/${c.max_score})`),
    "Điểm thử thách TB (/10)", "Nhận xét thử thách", "Giám khảo thử thách", "Phòng thử thách - Bàn", "Thời lượng thử thách (mm:ss)",
    "Giờ check-in", "Bắt đầu PV", "Kết thúc PV", "Link CV",
  ];

  const sorted = [...candidates].sort((a, b) => {
    const ea = evalBy.get(a.id)?.average_score ?? -1;
    const eb = evalBy.get(b.id)?.average_score ?? -1;
    return (a.department ?? "").localeCompare(b.department ?? "", "vi") || Number(eb) - Number(ea);
  });

  const rows = sorted.map((c) => {
    const e = evalBy.get(c.id);
    const source = c.source_candidate_id ? candidateById.get(c.source_candidate_id) : undefined;
    const dur = e?.duration_seconds ?? c.duration_seconds;
    return [
      c.code, c.student_number ?? source?.student_number ?? "", c.student_number_raw ?? "", source ? `Lượt 2 từ ${source.code}` : "Lượt 1", c.full_name, c.student_cohort ?? "",
      GENDERS.find((gender) => gender.code === c.gender)?.name ?? "", c.phone ?? "", c.email ?? "",
      c.facebook_url ?? "", c.department ?? "", specializationLabel(c.specialization) ?? "", candidateApplicationDay(c, e) ? dayLabel(candidateApplicationDay(c, e)!) : "", candidateApplicationShift(c, e) ?? "", STATUS_LABEL[getApplicationStatus(c)], candidateApplicationNote(c, e) ?? "",
      ...crit.map((k) => (e?.scores?.[k.id] != null ? Number(e.scores[k.id]) : "")),
      e?.average_score != null ? Number(e.average_score) : "",
      e?.comment ?? "",
      dur != null ? formatDuration(dur) : "",
      e?.interviewer_name ?? "",
      e?.table_label ?? "",
      ...crit.map((k) => (e?.challenge_scores?.[k.id] != null ? Number(e.challenge_scores[k.id]) : "")),
      e?.challenge_average_score != null ? Number(e.challenge_average_score) : "",
      e?.challenge_comment ?? "",
      e?.challenge_interviewer_name ?? "",
      e?.challenge_table_label ?? "",
      e?.challenge_duration_seconds != null ? formatDuration(e.challenge_duration_seconds) : "",
      formatDateTime(c.checked_in_at),
      formatDateTime(e?.started_at ?? c.interview_started_at),
      formatDateTime(e?.ended_at ?? c.interview_ended_at),
      c.cv_url ?? "",
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h) => ({ wch: h.includes("Nhận xét") ? 50 : Math.min(Math.max(h.length + 2, 10), 30) }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  ws["!freeze"] = { xSplit: 2, ySplit: 1 };

  // Tổng hợp theo ban
  const byDept = new Map<string, { total: number; done: number; absent: number; sum: number; n: number; dur: number; dn: number }>();
  for (const c of candidates) {
    const k = c.department || "(Chưa rõ ban)";
    const s = byDept.get(k) ?? { total: 0, done: 0, absent: 0, sum: 0, n: 0, dur: 0, dn: 0 };
    const status = getApplicationStatus(c);
    s.total++;
    if (status === "COMPLETED") s.done++;
    if (status === "ABSENT") s.absent++;
    const e = evalBy.get(c.id);
    if (e?.average_score != null) { s.sum += Number(e.average_score); s.n++; }
    if (e?.duration_seconds != null) { s.dur += e.duration_seconds; s.dn++; }
    byDept.set(k, s);
  }
  const summary = XLSX.utils.aoa_to_sheet([
    ["Ban", "Tổng thí sinh", "Đã phỏng vấn", "Vắng", "Điểm TB của ban", "Thời lượng TB (mm:ss)"],
    ...[...byDept.entries()].map(([k, s]) => [
      k, s.total, s.done, s.absent,
      s.n ? Math.round((s.sum / s.n) * 100) / 100 : "",
      s.dn ? formatDuration(s.dur / s.dn) : "",
    ]),
  ]);
  summary["!cols"] = [24, 14, 14, 8, 16, 20].map((wch) => ({ wch }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kết quả");
  if (!filter?.day) {
    const days = [...new Set(sorted.map((candidate) => candidateApplicationDay(candidate, evalBy.get(candidate.id))).filter((day): day is string => !!day))].sort();
    for (const day of days) {
      const dayRows = rows.filter((_, index) => candidateApplicationDay(sorted[index], evalBy.get(sorted[index].id)) === day);
      const daySheet = XLSX.utils.aoa_to_sheet([header, ...dayRows]);
      daySheet["!cols"] = ws["!cols"];
      daySheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dayRows.length, c: header.length - 1 } }) };
      daySheet["!freeze"] = { xSplit: 2, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, daySheet, dayLabel(day).replaceAll("/", "-"));
    }
  }
  XLSX.utils.book_append_sheet(wb, summary, "Tổng hợp theo ban");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  XLSX.writeFile(wb, `ket_qua_phong_van${filter?.department ? `_${filter.department}` : ""}${filter?.day ? `_${filter.day.replaceAll("-", "")}` : ""}_${stamp}.xlsx`);
}
