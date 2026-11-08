import * as XLSX from "xlsx";
import { normalizeDepartment } from "@/lib/departments";

export type ScheduleImportRow = { student_number: string | null; email: string | null; shift: string };

/** Read the three day sheets exported from the interview schedule workbook. */
export async function readInterviewSchedule(file: File, year: number): Promise<{ rows: ScheduleImportRow[]; days: string[] }> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error("Năm phỏng vấn không hợp lệ");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const rows: ScheduleImportRow[] = [];
  const days = new Set<string>();
  for (const sheetName of workbook.SheetNames) {
    const dateParts = sheetName.match(/\((\d{2})(\d{2})\)/);
    if (!dateParts) continue;
    const day = Number(dateParts[1]);
    const month = Number(dateParts[2]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error(`Ngày không hợp lệ ở sheet ${sheetName}`);
    }
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1, raw: false, defval: "", blankrows: true,
    });
    const header = matrix.findIndex((row) => row.some((value) => String(value).trim().toUpperCase() === "THỜI GIAN"));
    if (header < 0) throw new Error(`Thiếu cột THỜI GIAN ở sheet ${sheetName}`);
    const timeCol = matrix[header].findIndex((value) => String(value).trim().toUpperCase() === "THỜI GIAN");
    const dayLabel = `${dateParts[1]}/${dateParts[2]}/${year}`;
    days.add(dayLabel);
    matrix.slice(header + 1).forEach((row, index) => {
      const name = String(row[timeCol + 1] ?? "").trim();
      const time = String(row[timeCol] ?? "").trim();
      if (!name && !time) return;
      const match = time.match(/^(\d{1,2})h(\d{2})$/i);
      if (!name || !match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        throw new Error(`Giờ hoặc họ tên không hợp lệ ở ${sheetName}, dòng ${header + index + 2}`);
      }
      const department = normalizeDepartment(String(row[timeCol + 4] ?? ""));
      if (!department) throw new Error(`Ban không hợp lệ ở ${sheetName}, dòng ${header + index + 2}`);
      const studentNumber = String(row[timeCol + 2] ?? "").trim().toUpperCase();
      const email = String(row[timeCol + 3] ?? "").trim().toLowerCase();
      if (!studentNumber && !email) throw new Error(`Thiếu MSSV và Email ở ${sheetName}, dòng ${header + index + 2}`);
      rows.push({
        student_number: studentNumber || null,
        email: email || null,
        shift: `${dayLabel} ${match[1].padStart(2, "0")}:${match[2]} (${department})`,
      });
    });
  }
  if (!rows.length) throw new Error("Không tìm thấy lịch phỏng vấn trong file");
  rows.sort((a, b) => {
    const key = (shift: string) => `${shift.slice(6, 10)}${shift.slice(3, 5)}${shift.slice(0, 2)}${shift.slice(11, 16)}`;
    return key(a.shift).localeCompare(key(b.shift));
  });
  return { rows, days: [...days].sort((a, b) => a.split("/").reverse().join("").localeCompare(b.split("/").reverse().join(""))) };
}
