"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, Loader2, Upload, AlertTriangle, Download, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FIELD_LABEL, applyMapping, autoMapHeaders, downloadTemplate, readSpreadsheet,
  type CandidateField, type ParsedSheet,
} from "@/lib/excel";
import { importCandidates } from "../actions";
import { importSchedules } from "../actions";
import { readInterviewSchedule, type ScheduleImportRow } from "@/lib/schedule";

const FIELDS = Object.keys(FIELD_LABEL) as CandidateField[];
const SELECT_CLS = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";

export function ImportDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<(CandidateField | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleYear, setScheduleYear] = useState(new Date().getFullYear());
  const [schedule, setSchedule] = useState<{ fileName: string; rows: ScheduleImportRow[]; days: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await readSpreadsheet(file);
      setSheet(parsed);
      setFileName(file.name);
      setMapping(autoMapHeaders(parsed.headers));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không đọc được file");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function setField(col: number, field: CandidateField | null) {
    setMapping((m) => m.map((f, i) => (i === col ? field : f === field && field ? null : f)));
  }

  const result = sheet ? applyMapping(sheet, mapping) : null;
  const hasRequired = mapping.includes("student_number") && mapping.includes("full_name") && mapping.includes("gender") && mapping.includes("department");
  const canImport = hasRequired && !!result?.valid.length && result.errors.length === 0 && result.duplicates.length === 0;
  const mappedColumns = mapping.flatMap((field, index) => field ? [{ field, index }] : []);

  async function submit() {
    if (!result || !canImport) return;
    setBusy(true);
    const res = await importCandidates(
      result.valid.map((v) => ({
        student_number: v.student_number!, full_name: v.full_name!, student_cohort: v.student_cohort,
        gender: v.gender!, phone: v.phone, email: v.email, facebook_url: v.facebook_url,
        department: v.department!, specialization: v.specialization,
      }))
    );
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Đã import ${res.data?.count ?? 0} thí sinh`);
    setOpen(false);
    setSheet(null);
    onDone();
  }

  async function onScheduleFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await readInterviewSchedule(file, scheduleYear);
      setSchedule({ fileName: file.name, ...parsed });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không đọc được lịch");
    }
  }

  async function submitSchedule() {
    if (!schedule || busy) return;
    setBusy(true);
    const result = await importSchedules(schedule.rows);
    setBusy(false);
    if (!result.ok) return toast.error(result.error);
    toast.success(`Đã cập nhật ${result.data?.count ?? 0} dòng lịch phỏng vấn`);
    setScheduleOpen(false);
    setSchedule(null);
    onDone();
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Upload /> Import Excel
      </Button>
      <Button variant="outline" onClick={() => setScheduleOpen(true)}><CalendarDays /> Import lịch phỏng vấn</Button>
      <Dialog open={scheduleOpen} onOpenChange={(value) => { setScheduleOpen(value); if (!value) setSchedule(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import lịch phỏng vấn vào Ca</DialogTitle>
            <DialogDescription>Nhập danh sách thí sinh trước. Lịch 09–11/11 được đối chiếu bằng MSSV hoặc Email; mọi dòng phải khớp thì mới cập nhật. Nhiều lịch của cùng một thí sinh sẽ được giữ chung trong Ca.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">Năm phỏng vấn
            <input type="number" min="2020" max="2100" value={scheduleYear} onChange={(event) => { setScheduleYear(Number(event.target.value)); setSchedule(null); }} className="h-10 rounded-md border border-input bg-background px-3" />
          </label>
          <label className="grid cursor-pointer gap-2 rounded-lg border border-dashed p-5 text-sm hover:bg-muted/50">
            <span>Chọn file Excel lịch phỏng vấn</span>
            <input type="file" accept=".xlsx,.xls" onChange={(event) => void onScheduleFile(event.target.files?.[0])} />
          </label>
          {schedule && <p className="text-sm"><b>{schedule.fileName}</b><br />{schedule.rows.length} lượt · {schedule.days.join(", ")}</p>}
          <DialogFooter><Button onClick={() => void submitSchedule()} disabled={!schedule || busy}>{busy ? <Loader2 className="animate-spin" /> : <CalendarDays />} Cập nhật Ca</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSheet(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Import danh sách thí sinh</DialogTitle>
            <DialogDescription>
              Hỗ trợ .xlsx, .xls, .csv từ Google Form. Chỉ lấy thông tin cá nhân và Ban; bỏ qua Ca cùng các câu trả lời chuyên môn. Dòng tô đỏ được loại khỏi file nhập.
              Hệ thống tạo mã ứng viên riêng, dùng MSSV để nhận diện khi import lại và giữ nguyên trạng thái hiện tại.
            </DialogDescription>
          </DialogHeader>

          {!sheet ? (
            <div className="grid gap-3">
              <label
                className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center hover:bg-muted/50"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]); }}
              >
                <FileSpreadsheet className="size-10 text-muted-foreground" />
                <span className="font-medium">Chọn hoặc kéo thả file vào đây</span>
                <span className="text-xs text-muted-foreground">Dòng đầu tiên là tên cột</span>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="sr-only"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </label>
              <Button variant="link" className="justify-self-center" onClick={downloadTemplate}>
                <Download /> Tải file mẫu
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              <p className="text-sm">
                <b>{fileName}</b> · sheet “{sheet.sheetName}” · {sheet.rows.length} dòng
              </p>
              {!!sheet.skippedRed && <p className="text-sm font-medium text-red-700">Đã loại {sheet.skippedRed} đơn tô đỏ.</p>}
              <p className="text-xs text-muted-foreground">Xem trước chỉ hiện các cột đã chọn nhập. Các câu trả lời khác không được gửi vào database.</p>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {mappedColumns.map(({ field, index }) => <TableHead key={index} className="min-w-36">{FIELD_LABEL[field]}</TableHead>)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sheet.rows.slice(0, 5).map((r, ri) => (
                      <TableRow key={ri}>
                        {mappedColumns.map(({ index }) => (
                          <TableCell key={index} className="max-w-48 truncate text-xs">{String(r[index] ?? "")}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader><TableRow>
                    {sheet.headers.map((h, i) => <TableHead key={i} className="min-w-36 align-top">
                      <div className="py-2">
                        <p className="mb-1 truncate text-xs font-normal text-muted-foreground" title={h}>Cột: {h || `(trống ${i + 1})`}</p>
                        <select className={SELECT_CLS} value={mapping[i] ?? ""}
                          onChange={(e) => setField(i, (e.target.value || null) as CandidateField | null)} aria-label={`Map cột ${h}`}>
                          <option value="">— Bỏ qua —</option>
                          {FIELDS.map((field) => <option key={field} value={field}>{FIELD_LABEL[field]}</option>)}
                        </select>
                      </div>
                    </TableHead>)}
                  </TableRow></TableHeader>
                </Table>
              </div>

              {!hasRequired && (
                <p className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <AlertTriangle className="size-4" /> Bắt buộc map “MSSV”, “Họ tên”, “Giới tính” và “Ban ứng tuyển”.
                </p>
              )}
              {result && hasRequired && (
                <div className="grid gap-2 text-sm">
                  <p>
                    Hợp lệ: <b className="text-emerald-700 dark:text-emerald-400">{result.valid.length}</b>
                    {result.errors.length > 0 && <> · Lỗi: <b className="text-red-600">{result.errors.length}</b> (chặn import)</>}
                  </p>
                  {result.duplicates.length > 0 && (
                    <p className="text-amber-700 dark:text-amber-300">
                      MSSV bị trùng trong file (cần sửa trước khi import): {result.duplicates.slice(0, 10).join(", ")}
                      {result.duplicates.length > 10 && "…"}
                    </p>
                  )}
                  {result.mergedDuplicates > 0 && <p className="text-sm text-muted-foreground">Đã gộp {result.mergedDuplicates} đơn nộp lặp cùng MSSV.</p>}
                  {result.invalidStudentRows.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">{result.invalidStudentRows.length} dòng có MSSV chưa đúng 8 ký tự (dòng {result.invalidStudentRows.join(", ")}). Vẫn nhập bằng Email; Admin cần xác minh và sửa MSSV sau.</p>}
                  {result.errors.length > 0 && (
                    <ul className="max-h-24 overflow-y-auto text-xs text-red-600">
                      {result.errors.slice(0, 50).map((e) => (
                        <li key={e.row}>Dòng {e.row}: {e.message}</li>
                      ))}
                    </ul>
                  )}
                  {(result.errors.length > 0 || result.duplicates.length > 0) && (
                    <p className="text-amber-700 dark:text-amber-300">Chưa nhập dữ liệu. Hãy sửa file rồi chọn lại để tránh nhập thiếu hoặc ghi đè nhầm thí sinh.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {sheet && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setSheet(null)}>Chọn file khác</Button>
              <Button onClick={submit} disabled={busy || !canImport}>
                {busy ? <Loader2 className="animate-spin" /> : <Upload />}
                Import {result?.valid.length ?? 0} thí sinh
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
