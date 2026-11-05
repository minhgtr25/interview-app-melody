import * as XLSX from "xlsx";
import { normalizeDepartment } from "@/lib/departments";
import { formatDateTime, formatDuration, normalizePhone, normalizeText } from "@/lib/format";
import {
  STATUS_LABEL,
  type Candidate,
  type Evaluation,
  type RubricCriterion,
} from "@/lib/types";

export type CandidateField = "code" | "full_name" | "phone" | "email" | "department" | "shift" | "cv_url";

export const FIELD_LABEL: Record<CandidateField, string> = {
  code: "Mã ứng viên",
  full_name: "Họ tên",
  phone: "SĐT",
  email: "Email",
  department: "Ban ứng tuyển",
  shift: "Ca phỏng vấn",
  cv_url: "Link CV",
};

/** Các tên cột thường gặp (đã bỏ dấu, lowercase) để tự động map. */
const ALIASES: Record<CandidateField, string[]> = {
  code: ["ma ung vien", "ma uv", "ma thi sinh", "ma ts", "ma so", "ma", "id", "code", "candidate id", "sbd", "so bao danh"],
  full_name: ["ho ten", "ho va ten", "ten", "ten ung vien", "ten thi sinh", "full name", "name", "fullname"],
  phone: ["sdt", "so dien thoai", "dien thoai", "phone", "phone number", "dt", "mobile"],
  email: ["email", "e-mail", "mail", "gmail", "dia chi email"],
  department: ["ban ung tuyen", "ban", "ban dang ky", "nguyen vong", "bo phan", "department", "team", "vi tri"],
  shift: ["ca phong van", "ca", "ca pv", "khung gio", "shift", "slot", "gio phong van"],
  cv_url: ["link cv", "cv", "link", "cv url", "portfolio", "link portfolio", "ho so", "url"],
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

export type ParsedSheet = { headers: string[]; rows: unknown[][]; sheetName: string };

export async function readSpreadsheet(file: File): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("File không có sheet nào");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: false, // lấy chuỗi hiển thị (giữ số 0 đầu nếu ô định dạng Text)
    defval: "",
    blankrows: false,
  });
  // Bỏ các dòng trống đầu file, dòng đầu tiên có dữ liệu là header
  const start = matrix.findIndex((r) => r.some((v) => String(v).trim() !== ""));
  if (start === -1) throw new Error("File trống");
  const headers = matrix[start].map((h) => String(h).trim());
  const rows = matrix.slice(start + 1).filter((r) => r.some((v) => String(v).trim() !== ""));
  return { headers, rows, sheetName };
}

export type MappedCandidate = Record<CandidateField, string | null>;

export function applyMapping(sheet: ParsedSheet, mapping: (CandidateField | null)[]) {
  const valid: MappedCandidate[] = [];
  const errors: { row: number; message: string }[] = [];
  sheet.rows.forEach((r, i) => {
    const rec: MappedCandidate = { code: null, full_name: null, phone: null, email: null, department: null, shift: null, cv_url: null };
    mapping.forEach((field, col) => {
      if (!field) return;
      const v = String(r[col] ?? "").trim();
      if (v) rec[field] = v;
    });
    rec.phone = normalizePhone(rec.phone);
    const rowNo = i + 2; // +1 header, +1 đánh số từ 1
    if (!rec.code && !rec.full_name && !rec.department && !rec.phone && !rec.email) return;
    if (!rec.code) return errors.push({ row: rowNo, message: "Thiếu mã ứng viên" });
    if (!rec.full_name) return errors.push({ row: rowNo, message: "Thiếu họ tên" });
    const department = normalizeDepartment(rec.department);
    if (!department) return errors.push({ row: rowNo, message: "Thiếu Ban hoặc Ban không thuộc CM, VH, TT, DE, HCTC" });
    rec.department = department;
    valid.push(rec);
  });
  const seen = new Map<string, number>();
  valid.forEach((v) => seen.set(v.code!, (seen.get(v.code!) ?? 0) + 1));
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  return { valid, errors, duplicates };
}

/** File mẫu để Admin điền danh sách. */
export function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    Object.values(FIELD_LABEL),
    ["UV001", "Nguyễn Văn A", "0901234567", "a.nguyen@example.com", "Truyền thông", "Ca 1 (8:00-10:00)", "https://drive.google.com/..."],
    ["UV002", "Trần Thị B", "0912345678", "b.tran@example.com", "Sự kiện", "Ca 1 (8:00-10:00)", ""],
  ]);
  ws["!cols"] = [10, 24, 14, 28, 18, 20, 40].map((wch) => ({ wch }));
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
  criteria: RubricCriterion[]
) {
  const evalBy = new Map(evaluations.map((e) => [e.candidate_id, e]));
  const crit = [...criteria].sort((a, b) => a.sort_order - b.sort_order);

  const header = [
    "Mã ứng viên", "Họ tên", "SĐT", "Email", "Ban ứng tuyển", "Ca phỏng vấn", "Trạng thái",
    ...crit.map((c) => `${c.name} (/${c.max_score})`),
    "Điểm TB (/10)", "Nhận xét", "Thời lượng (mm:ss)", "Người chấm", "Phòng - Bàn",
    "Giờ check-in", "Bắt đầu PV", "Kết thúc PV", "Link CV",
  ];

  const sorted = [...candidates].sort((a, b) => {
    const ea = evalBy.get(a.id)?.average_score ?? -1;
    const eb = evalBy.get(b.id)?.average_score ?? -1;
    return (a.department ?? "").localeCompare(b.department ?? "", "vi") || Number(eb) - Number(ea);
  });

  const rows = sorted.map((c) => {
    const e = evalBy.get(c.id);
    const dur = e?.duration_seconds ?? c.duration_seconds;
    return [
      c.code, c.full_name, c.phone ?? "", c.email ?? "", c.department ?? "", c.shift ?? "", STATUS_LABEL[c.status],
      ...crit.map((k) => (e?.scores?.[k.id] != null ? Number(e.scores[k.id]) : "")),
      e?.average_score != null ? Number(e.average_score) : "",
      e?.comment ?? "",
      dur != null ? formatDuration(dur) : "",
      e?.interviewer_name ?? "",
      e?.table_label ?? "",
      formatDateTime(c.checked_in_at),
      formatDateTime(e?.started_at ?? c.interview_started_at),
      formatDateTime(e?.ended_at ?? c.interview_ended_at),
      c.cv_url ?? "",
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h, i) => ({ wch: i === header.indexOf("Nhận xét") ? 50 : Math.min(Math.max(h.length + 2, 10), 30) }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  ws["!freeze"] = { xSplit: 2, ySplit: 1 };

  // Tổng hợp theo ban
  const byDept = new Map<string, { total: number; done: number; absent: number; sum: number; n: number; dur: number; dn: number }>();
  for (const c of candidates) {
    const k = c.department || "(Chưa rõ ban)";
    const s = byDept.get(k) ?? { total: 0, done: 0, absent: 0, sum: 0, n: 0, dur: 0, dn: 0 };
    s.total++;
    if (c.status === "COMPLETED") s.done++;
    if (c.status === "ABSENT") s.absent++;
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
  XLSX.utils.book_append_sheet(wb, summary, "Tổng hợp theo ban");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  XLSX.writeFile(wb, `ket_qua_phong_van_${stamp}.xlsx`);
}
