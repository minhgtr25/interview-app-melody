"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Search, Trash2, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BuildingRadio } from "@/components/building-radio";
import { DepartmentRadio } from "@/components/department-radio";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createClient } from "@/lib/supabase/client";
import { errorMessage, normalizeText } from "@/lib/format";
import { BUILDINGS, isBuildingCode, isRoomNumber, roomCode, type BuildingCode } from "@/lib/rooms";
import { Input } from "@/components/ui/input";
import { DEPARTMENTS, isDepartmentCode, type DepartmentCode } from "@/lib/departments";
import type { InterviewTable, Profile, Room } from "@/lib/types";
import { assignRoomTableAccounts, createTableAccount, deleteAccount } from "@/app/admin/actions";
import { SPECIALIZATIONS_BY_DEPARTMENT, isSpecializedDepartment, isSpecializationForDepartment, specializationLabel, type SpecializationCode } from "@/lib/specializations";
import { dayLabel, todayInVietnam } from "@/lib/interview-days";
import { useServerNow } from "@/components/clock";

type TableSetup = { department: DepartmentCode | ""; specialization: SpecializationCode | ""; createAccount: boolean; judgeId: string; secondJudgeId: string };
type RoomForm = {
  building: BuildingCode | "";
  number: string;
  count: 1 | 2 | 3 | 4;
  isChallenge: boolean;
  externalChallenge: boolean;
  tables: TableSetup[];
};

const emptyTable = (): TableSetup => ({ department: "", specialization: "", createAccount: true, judgeId: "", secondJudgeId: "" });
const emptyForm = (): RoomForm => ({ building: "", number: "", count: 2, isChallenge: false, externalChallenge: false, tables: [emptyTable(), emptyTable(), emptyTable(), emptyTable()] });

function RoomFields({ form, setForm, judges, disabled, prefix, occupiedExistingDeskCount }: {
  form: RoomForm;
  setForm: (form: RoomForm) => void;
  judges: Profile[];
  disabled: boolean;
  prefix: string;
  occupiedExistingDeskCount?: number;
}) {
  const selectedTables = form.tables.slice(0, form.count);
  const challengeDepartment = selectedTables[0]?.department;
  const canConfigureExternalChallenge = challengeDepartment === "VH" &&
    selectedTables.every((table) => table.department === challengeDepartment);
  const canConfigureChallenge = challengeDepartment === "HCTC" &&
    selectedTables.every((table) => table.department === challengeDepartment);
  const changeTable = (index: number, patch: Partial<TableSetup>) => {
    const nextTables = form.tables.map((table, i) => i === index ? {
      ...table, ...patch,
      ...(patch.department && !isSpecializationForDepartment(patch.department, table.specialization) ? { specialization: "" as const } : {}),
    } : table);
    const activeTables = nextTables.slice(0, form.count);
    setForm({ ...form, tables: nextTables,
      isChallenge: form.isChallenge && activeTables.every((table) => table.department === "HCTC"),
      externalChallenge: form.externalChallenge && activeTables.every((table) => table.department === "VH"),
    });
  };
  return <div className="space-y-4">
    <div className="space-y-1.5">
      <p className="text-sm font-medium">1. Tòa học</p>
      <BuildingRadio name={`${prefix}-building`} value={form.building}
        onChange={(building) => setForm({ ...form, building, number: building === form.building ? form.number : "" })} disabled={disabled} />
    </div>
    <div className="flex flex-wrap gap-5">
      <label className="grid min-w-36 gap-1.5 text-sm font-medium">2. Số phòng
        <Input aria-label="Số phòng" inputMode="numeric" maxLength={3} placeholder="Ví dụ: 318"
          value={form.number} disabled={disabled || !form.building}
          onChange={(event) => setForm({ ...form, number: event.target.value.replace(/\D/g, "").slice(0, 3) })} />
        <span className="text-xs font-normal text-muted-foreground">Tầng 1–4: 101–140, 201–240, 301–340, 401–440.</span>
      </label>
      <fieldset className="space-y-1.5" disabled={disabled}>
        <legend className="text-sm font-medium">3. Số bàn</legend>
        <div className="flex gap-3">
          {([1, 2, 3, 4] as const).map((count) => <label key={count} className="flex items-center gap-1.5 text-sm">
            <input type="radio" name={`${prefix}-count`} checked={form.count === count}
              disabled={form.isChallenge && count !== 2}
              onChange={() => setForm({ ...form, count,
                isChallenge: form.isChallenge && form.tables.slice(0, count).every((table) => table.department === "HCTC"),
                externalChallenge: form.externalChallenge && form.tables.slice(0, count).every((table) => table.department === "VH"),
              })} />{count} bàn
          </label>)}
        </div>
      </fieldset>
    </div>
    {canConfigureExternalChallenge && <label className="flex items-start gap-2 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950/30">
      <input type="checkbox" checked={form.externalChallenge} disabled={disabled}
        onChange={(event) => setForm({ ...form, externalChallenge: event.target.checked, isChallenge: false })} />
      <span><span className="block font-semibold">Văn hoá · Phỏng vấn 2 vòng (thử thách ngoài phòng)</span>
        <span className="text-muted-foreground">Không cần tạo phòng Debate. Sau vòng 1, bàn được giải phóng; Giám khảo theo dõi và xác nhận hoàn tất vòng 2 tại sidebar.</span></span>
    </label>}
    {canConfigureChallenge && <label className="flex items-start gap-2 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950/30">
      <input type="checkbox" checked={form.isChallenge} disabled={disabled}
        onChange={(event) => setForm({ ...form, isChallenge: event.target.checked, externalChallenge: false, count: event.target.checked ? 2 : form.count,
          tables: form.tables.map((table) => ({ ...table, createAccount: !event.target.checked, judgeId: "", secondJudgeId: "" })) })} />
      <span><span className="block font-semibold">HCTC · Phòng Debate cho vòng thử thách</span>
        <span className="text-muted-foreground">Cấp tài khoản riêng ở mục Tài khoản trước. Mỗi bàn cần Giám khảo 1 và có thể thêm Giám khảo 2.</span></span>
    </label>}
    {form.building && isRoomNumber(form.number) && <p className="text-sm font-semibold">Mã phòng: {roomCode(form.building, form.number)}</p>}
    <h4 className="text-sm font-semibold">4. Cấu hình từng bàn</h4>
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {form.tables.slice(0, form.count).map((table, index) => <div key={index} className="space-y-3 rounded-lg border p-3">
        <p className="font-semibold">Bàn {index + 1}</p>
        <DepartmentRadio name={`${prefix}-table-${index}`} value={table.department}
          onChange={(department) => changeTable(index, { department })} disabled={disabled} />
        {isSpecializedDepartment(table.department) && <label className="grid gap-1.5 text-sm font-medium">Ngạch phụ trách bàn
          <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={table.specialization} disabled={disabled}
            onChange={(event) => changeTable(index, { specialization: event.target.value as SpecializationCode | "" })}>
            <option value="">Chọn ngạch</option>
            {(table.department === "CM" ? SPECIALIZATIONS_BY_DEPARTMENT.CM : SPECIALIZATIONS_BY_DEPARTMENT.TT).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </label>}
        {!form.isChallenge && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={table.createAccount} disabled={disabled}
            onChange={(event) => changeTable(index, { createAccount: event.target.checked, judgeId: "" })} />
           Tạo tài khoản đại diện cho bàn
        </label>}
        {(form.isChallenge || !table.createAccount) && <label className="grid gap-1 text-sm">{form.isChallenge ? "Giám khảo Debate 1 · chính" : "Tài khoản đại diện có sẵn"}
          <select aria-label={`Tài khoản đại diện Bàn ${index + 1}`} className="h-9 rounded-lg border border-input bg-background px-2"
             value={table.judgeId} disabled={disabled} onChange={(event) => changeTable(index, { judgeId: event.target.value, secondJudgeId: event.target.value === table.secondJudgeId ? "" : table.secondJudgeId })}>
            <option value="">Chọn tài khoản</option>
            {judges.filter((judge) => occupiedExistingDeskCount === undefined || index < occupiedExistingDeskCount || !judge.table_id)
              .map((judge) => <option key={judge.id} value={judge.id}>{judge.full_name || judge.email}</option>)}
          </select>
        </label>}
        {form.isChallenge && <label className="grid gap-1 text-sm">Giám khảo Debate 2 · phụ (tuỳ chọn)
          <select aria-label={`Giám khảo Debate 2 Bàn ${index + 1}`} className="h-9 rounded-lg border border-input bg-background px-2"
            value={table.secondJudgeId} disabled={disabled} onChange={(event) => changeTable(index, { secondJudgeId: event.target.value })}>
            <option value="">Chỉ dùng 1 tài khoản tại bàn</option>
            {judges.filter((judge) => judge.id !== table.judgeId &&
              (occupiedExistingDeskCount === undefined || index < occupiedExistingDeskCount || !judge.table_id))
              .map((judge) => <option key={judge.id} value={judge.id}>{judge.full_name || judge.email}</option>)}
          </select>
        </label>}
      </div>)}
    </div>
  </div>;
}

function ExistingRoom({ room, tables, profiles, busy, onSave, onDelete }: {
  room: Room;
  tables: InterviewTable[];
  profiles: Profile[];
  busy: boolean;
  onSave: (room: Room, form: RoomForm) => Promise<unknown>;
  onDelete: (room: Room) => void;
}) {
  const sorted = [...tables].sort((a, b) => a.sort_order - b.sort_order);
  const [editing, setEditing] = useState(false);
  const currentForm = (): RoomForm => ({
    building: room.building_code ?? "",
    number: room.room_number ?? "",
    count: sorted.length >= 1 && sorted.length <= 4 ? sorted.length as 1 | 2 | 3 | 4 : 2,
    isChallenge: room.is_challenge && sorted[0]?.department === "HCTC",
    externalChallenge: room.external_challenge ?? (room.is_challenge && sorted[0]?.department === "VH"),
    tables: [0, 1, 2, 3].map((index) => ({
      department: sorted[index]?.department ?? "",
      specialization: sorted[index]?.specialization ?? "",
      createAccount: !room.is_challenge && !profiles.some((profile) => profile.role === "INTERVIEWER" && profile.table_id === sorted[index]?.id),
       judgeId: profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === sorted[index]?.id && (!room.is_challenge || profile.debate_judge_position === 1))?.id ?? "",
       secondJudgeId: profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === sorted[index]?.id && profile.debate_judge_position === 2)?.id ?? "",
    })),
  });
  const [form, setForm] = useState<RoomForm>(currentForm);
  const openEditor = () => { setForm(currentForm()); setEditing(true); };
  const hasOccupiedTables = tables.some((table) => table.status !== "AVAILABLE");
  const roomTableIds = new Set(tables.map((table) => table.id));
  const availableJudges = profiles.filter((profile) => profile.role === "INTERVIEWER" && profile.is_debate_judge === room.is_challenge &&
    (!profile.table_id || roomTableIds.has(profile.table_id)));
  return <article className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex items-center justify-between gap-2">
      <div>
        <h3 className="font-semibold">{room.name}</h3>
        <p className="text-xs text-muted-foreground">{room.is_configured ? "Đã kích hoạt" : "Chưa kích hoạt"}</p>
      </div>
      <Button size="icon-sm" variant="ghost" className="text-red-600" aria-label={`Xóa ${room.name}`}
        onClick={() => onDelete(room)} disabled={busy}><Trash2 /></Button>
    </div>
    {!editing ? <>
      <ul className="space-y-1 text-sm">
        {sorted.map((table) => <li key={table.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
          <span>{table.name} ({table.department ?? "Chưa chọn Ban"}{table.specialization ? ` · ${specializationLabel(table.specialization)}` : ""})</span>
           <span className="text-muted-foreground">{profiles.filter((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id)
             .sort((a, b) => (a.debate_judge_position ?? 0) - (b.debate_judge_position ?? 0))
             .map((profile) => `${room.is_challenge ? `GK ${profile.debate_judge_position} · ` : ""}${profile.full_name || profile.email}`).join("; ") || "Chưa có tài khoản đại diện"}</span>
          <div className="flex items-center gap-2">
            {room.is_challenge ? profiles.filter((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id && profile.is_debate_judge)
              .sort((a, b) => (a.debate_judge_position ?? 0) - (b.debate_judge_position ?? 0))
              .map((judge) => <Link key={judge.id} href={`/admin-preview/${table.id}?judgeId=${judge.id}`}
                className="inline-flex h-8 items-center rounded-md border border-input bg-background px-2.5 text-xs font-medium hover:bg-muted">
                Mở GK {judge.debate_judge_position}
              </Link>) : <Link href={`/admin-preview/${table.id}`} className="inline-flex h-8 items-center rounded-md border border-input bg-background px-2.5 text-xs font-medium hover:bg-muted">
              Mở bàn
            </Link>}
            <Button size="xs" variant="outline" onClick={openEditor} disabled={busy} aria-label={`Cấu hình ${room.name} - ${table.name}`}>
              Cấu hình bàn
            </Button>
          </div>
        </li>)}
      </ul>
      <Button variant="outline" onClick={openEditor} disabled={busy}>Cấu hình phòng và bàn</Button>
    </> : <>
      {hasOccupiedTables && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        Phòng đang có bàn phỏng vấn. Bạn vẫn có thể tăng số bàn; thông tin và tài khoản các bàn hiện tại sẽ được giữ nguyên.
      </p>}
      <RoomFields form={form} setForm={setForm} judges={availableJudges} disabled={busy}
        prefix={`room-${room.id}`} occupiedExistingDeskCount={hasOccupiedTables ? sorted.length : undefined} />
      <div className="flex gap-2">
        <Button onClick={() => void onSave(room, form)} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Lưu và kích hoạt
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Đóng</Button>
      </div>
    </>}
  </article>;
}

export function RoomsManager({ rooms, tables, profiles, activeDay }: { rooms: Room[]; tables: InterviewTable[]; profiles: Profile[]; activeDay: string }) {
  const now = useServerNow(30_000);
  const router = useRouter();
  const [newForm, setNewForm] = useState<RoomForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [deleteRoom, setDeleteRoom] = useState<Room | null>(null);
  const [newCredentials, setNewCredentials] = useState<{ table: string; email: string; password: string }[]>([]);
  const [roomQuery, setRoomQuery] = useState("");
  const [roomDepartment, setRoomDepartment] = useState<DepartmentCode | "">("");
  const supabase = createClient();
  const judges = profiles.filter((profile) => profile.role === "INTERVIEWER");
  const dayReady = activeDay === todayInVietnam(now);
  const filteredRooms = useMemo(() => rooms.filter((room) => {
    const roomTables = tables.filter((table) => table.room_id === room.id);
    if (roomDepartment && !roomTables.some((table) => table.department === roomDepartment)) return false;
     const judgeNames = roomTables.flatMap((table) => profiles.filter((profile) =>
       profile.role === "INTERVIEWER" && profile.table_id === table.id)
       .map((judge) => `${judge.full_name} ${judge.email}`)).join(" ");
    const tableText = roomTables.map((table) => `${table.name} ${table.department ?? ""} ${table.specialization ? specializationLabel(table.specialization) : ""}`).join(" ");
    return !roomQuery || normalizeText(`${room.name} ${room.building_code ?? ""} ${tableText} ${judgeNames}`).includes(normalizeText(roomQuery));
  }), [rooms, tables, profiles, roomQuery, roomDepartment]);

  async function saveRoom(existing: Room | null, form: RoomForm) {
    if (!dayReady) return toast.error("Kích hoạt bố trí phòng cho ngày hôm nay trước khi sửa phòng/bàn đang hoạt động");
    if (!isBuildingCode(form.building) || !isRoomNumber(form.number))
      return toast.error("Số phòng phải thuộc 101–140, 201–240, 301–340 hoặc 401–440");
    const selected = form.tables.slice(0, form.count);
    if (selected.some((table) => !isDepartmentCode(table.department) || (!table.createAccount && !table.judgeId)))
      return toast.error("Mỗi bàn cần Ban và một tài khoản đại diện");
    if (selected.some((table) => isSpecializedDepartment(table.department)
      ? !isSpecializationForDepartment(table.department, table.specialization)
      : !!table.specialization))
      return toast.error("Chọn ngạch phù hợp cho từng bàn thuộc Chuyên Môn hoặc Truyền Thông");
    if (form.isChallenge && selected.some((table) => table.department !== "HCTC"))
      return toast.error("Phòng Debate chỉ dùng riêng cho Ban HCTC");
    if (form.isChallenge && form.count !== 2) return toast.error("Phòng Debate phải có đúng 2 bàn");
    if (form.isChallenge && selected.some((table) => table.createAccount || !table.judgeId))
      return toast.error("Cấp tài khoản Giám khảo Debate 1 cho mỗi bàn trước khi tạo phòng");
    if (form.externalChallenge && selected.some((table) => table.department !== "VH"))
      return toast.error("Chế độ thử thách ngoài phòng chỉ dùng cho Ban Văn hoá");
    const existingIds = selected.filter((table) => !table.createAccount)
      .flatMap((table) => [table.judgeId, ...(form.isChallenge && table.secondJudgeId ? [table.secondJudgeId] : [])]);
    if (new Set(existingIds).size !== existingIds.length)
      return toast.error("Một tài khoản đại diện chỉ được gán cho một bàn");
    const currentTables = existing ? tables.filter((table) => table.room_id === existing.id)
      .sort((a, b) => a.sort_order - b.sort_order) : [];
    const occupiedTables = currentTables.filter((table) => table.status !== "AVAILABLE");
    const addOnlyWhileOccupied = occupiedTables.length > 0;
    if (addOnlyWhileOccupied) {
      const existingDeskChanged = currentTables.some((table, index) => {
        const setup = selected[index];
        const primary = profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id &&
          (!existing?.is_challenge || profile.debate_judge_position === 1));
        const secondary = profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id && profile.debate_judge_position === 2);
        return !setup || setup.department !== table.department || setup.specialization !== table.specialization || setup.createAccount ||
          setup.judgeId !== primary?.id || (form.isChallenge && setup.secondJudgeId !== (secondary?.id ?? ""));
      });
      if (!existing || selected.length <= currentTables.length ||
        form.building !== existing.building_code || form.number !== existing.room_number ||
        form.isChallenge !== existing.is_challenge || form.externalChallenge !== (existing.external_challenge ?? false) || existingDeskChanged) {
        return toast.error("Phòng đang có bàn bận: chỉ có thể tăng số bàn và giữ nguyên thông tin phòng, Ban, tài khoản của các bàn hiện tại.");
      }
    }
    const currentIds = new Set(currentTables.map((table) => table.id));
    if (selected.some((table) => !table.createAccount && [table.judgeId, ...(form.isChallenge && table.secondJudgeId ? [table.secondJudgeId] : [])]
      .some((id) => !judges.some((judge) => judge.id === id && judge.is_debate_judge === form.isChallenge &&
        (!judge.table_id || currentIds.has(judge.table_id))))))
      return toast.error("Tài khoản đại diện đã được gán ở phòng khác");

    setBusy(true);
    let roomId = existing?.id;
    let created = false;
    let completed = false;
    const generatedIds: string[] = [];
    const credentials: { table: string; email: string; password: string }[] = [];
    try {
      const [{ error: tableTrackError }, { error: oldRoomTrackError }] = await Promise.all([
        supabase.from("tables").select("specialization").limit(1),
        supabase.from("rooms").select("specialization").limit(1),
      ]);
      if (tableTrackError || !oldRoomTrackError) {
        throw new Error("Database chưa hoàn tất migration 18. Chạy lại file 20261118_table_specializations.sql trước khi cấu hình bàn.");
      }
      if (oldRoomTrackError.code !== "42703") throw oldRoomTrackError;
      if (existing && !addOnlyWhileOccupied) {
        const { error } = await supabase.from("rooms").update({
          building_code: form.building, room_number: form.number, is_configured: false, is_challenge: form.isChallenge,
          external_challenge: form.externalChallenge,
        }).eq("id", existing.id);
        if (error) throw error;
      } else if (!existing) {
        const { data, error } = await supabase.from("rooms").insert({
          name: roomCode(form.building, form.number), building_code: form.building,
          room_number: form.number, is_configured: false, is_challenge: form.isChallenge,
          external_challenge: form.externalChallenge,
          sort_order: (rooms.at(-1)?.sort_order ?? 0) + 1,
        }).select("id").single();
        if (error || !data) throw error ?? new Error("Không tạo được phòng");
        roomId = data.id;
        created = true;
      }
      if (!roomId) throw new Error("Không tìm thấy phòng");

      const resultIds: string[] = addOnlyWhileOccupied ? currentTables.map((table) => table.id) : [];
      const firstDeskToProcess = addOnlyWhileOccupied ? currentTables.length : 0;
      for (let index = firstDeskToProcess; index < form.count; index++) {
        const values = { name: `Bàn ${index + 1}`, sort_order: index + 1, department: selected[index].department, specialization: selected[index].specialization || null };
        if (currentTables[index]) {
          const { error } = await supabase.from("tables").update(values).eq("id", currentTables[index].id);
          if (error) throw error;
          resultIds.push(currentTables[index].id);
        } else {
          const { data, error } = await supabase.from("tables").insert({ ...values, room_id: roomId }).select("id").single();
          if (error || !data) throw error ?? new Error("Không tạo được bàn");
          resultIds.push(data.id);
        }
      }
      if (currentTables.length > form.count) {
        const { error } = await supabase.from("tables").delete().in("id", currentTables.slice(form.count).map((table) => table.id));
        if (error) throw error;
      }
      const existingAssignments = selected.slice(firstDeskToProcess, form.count)
        .flatMap((table, index) => [
          { tableId: resultIds[firstDeskToProcess + index], profileId: table.judgeId, position: form.isChallenge ? 1 as const : undefined },
          ...(form.isChallenge && table.secondJudgeId
            ? [{ tableId: resultIds[firstDeskToProcess + index], profileId: table.secondJudgeId, position: 2 as const }]
            : []),
        ]).filter((item) => !!item.profileId);
      const accountResult = await assignRoomTableAccounts(roomId, existingAssignments, !addOnlyWhileOccupied);
      if (!accountResult.ok) throw new Error(accountResult.error);
      for (let index = firstDeskToProcess; index < form.count; index++) {
        if (selected[index].createAccount) {
          const account = await createTableAccount(resultIds[index]);
          if (!account.ok || !account.data) throw new Error(account.ok ? "Không tạo được tài khoản" : account.error);
          generatedIds.push(account.data.id);
          credentials.push({ table: `${roomCode(form.building, form.number)} - Bàn ${index + 1}`, email: account.data.email, password: account.data.password });
        }
      }
      const { error: activationError } = await supabase.from("rooms").update({ is_configured: true }).eq("id", roomId);
      if (activationError) throw activationError;
      completed = true;
      toast.success(`Đã kích hoạt ${roomCode(form.building, form.number)}`);
      if (credentials.length) setNewCredentials(credentials);
      if (!existing) setNewForm(emptyForm());
    } catch (error) {
      for (const id of generatedIds) await deleteAccount(id);
      if (created && roomId) await supabase.from("rooms").delete().eq("id", roomId);
      const message = errorMessage(error);
      toast.error(message.includes("Chọn ngạch phù hợp với Ban của phòng")
        ? "Database vẫn dùng cấu hình ngạch theo phòng. Chạy lại migration 18 trước khi lưu ngạch theo từng bàn."
        : message);
    } finally {
      setBusy(false);
      if (!completed || !credentials.length) router.refresh();
    }
  }

  async function confirmDelete() {
    if (!dayReady) return toast.error("Kích hoạt ngày hôm nay trước khi xóa phòng");
    if (!deleteRoom) return;
    const room = deleteRoom;
    setDeleteRoom(null);
    if (tables.some((table) => table.room_id === room.id && table.status !== "AVAILABLE"))
      return toast.error("Phòng có bàn đang phỏng vấn, giải phóng trước khi xóa");
    setBusy(true);
    const { error } = await supabase.from("rooms").delete().eq("id", room.id);
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Đã xóa ${room.name}`);
    router.refresh();
  }

  return <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold">Cấu hình Phòng & Bàn đang hoạt động · {dayLabel(activeDay)}</h2>
      <p className="text-sm text-muted-foreground">Chọn Tòa, Số phòng, từ 1 đến 4 bàn, rồi chọn Ban và ngạch riêng cho từng bàn trước khi kích hoạt. Nhiều giám khảo có thể dùng chung máy của bàn; không cần cấp tài khoản riêng cho từng người.</p>
    </div>

    <section className="space-y-4 rounded-xl border bg-card p-4">
      <h3 className="font-semibold">Thêm phòng mới</h3>
      <RoomFields form={newForm} setForm={setNewForm} judges={judges.filter((judge) => !judge.table_id && judge.is_debate_judge === newForm.isChallenge)} disabled={busy || !dayReady} prefix="new-room" />
      <Button onClick={() => void saveRoom(null, newForm)} disabled={busy || !dayReady}>
        {busy ? <Loader2 className="animate-spin" /> : <Plus />} Thêm phòng và kích hoạt
      </Button>
    </section>

    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      {DEPARTMENTS.map((department) => {
        const matching = tables.filter((table) => table.department === department.code);
        const roomCount = new Set(matching.map((table) => table.room_id)).size;
        return <div key={department.code} className="rounded-lg border bg-card p-3 text-sm">
          <p className="font-semibold">{department.name} ({department.code})</p>
          <p className="text-muted-foreground">{roomCount} phòng · {matching.length} bàn</p>
        </div>;
      })}
    </section>

    <section className="space-y-3 rounded-xl border bg-card p-3" aria-label="Tìm và lọc phòng đã tạo">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={roomQuery} onChange={(event) => setRoomQuery(event.target.value)} className="pl-9 pr-9"
            placeholder="Tìm theo phòng, bàn, ban, ngạch hoặc tài khoản giám khảo" aria-label="Tìm phòng hoặc bàn" />
          {roomQuery && <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-1/2 -translate-y-1/2"
            aria-label="Xóa nội dung tìm kiếm" onClick={() => setRoomQuery("")}><X /></Button>}
        </div>
        {(roomQuery || roomDepartment) && <Button type="button" variant="ghost" size="sm" className="shrink-0"
          onClick={() => { setRoomQuery(""); setRoomDepartment(""); }}><RotateCcw /> Xóa bộ lọc</Button>}
      </div>
      <DepartmentRadio name="room-list-department" value={roomDepartment} onChange={setRoomDepartment} allowAll />
      <p className="text-xs text-muted-foreground" aria-live="polite">Hiển thị {filteredRooms.length}/{rooms.length} phòng</p>
    </section>

    {BUILDINGS.map((building) => {
      const buildingRooms = filteredRooms.filter((room) => room.building_code === building.code);
      if (!buildingRooms.length) return null;
      return <section key={building.code} className="space-y-3">
        <h3 className="text-base font-semibold">{building.name} ({building.code}) · {buildingRooms.length} phòng</h3>
        <div className="grid gap-4 xl:grid-cols-2">
          {buildingRooms.map((room) => <ExistingRoom key={`${room.id}-${room.is_configured}-${room.name}`}
            room={room} tables={tables.filter((table) => table.room_id === room.id)} profiles={profiles}
            busy={busy || !dayReady} onSave={(target, form) => saveRoom(target, form)} onDelete={setDeleteRoom} />)}
        </div>
      </section>;
    })}
    {filteredRooms.some((room) => !room.building_code) && <section className="space-y-3">
      <h3 className="text-base font-semibold">Phòng cũ cần chọn Tòa và Số phòng</h3>
      <div className="grid gap-4 xl:grid-cols-2">
        {filteredRooms.filter((room) => !room.building_code).map((room) => <ExistingRoom key={`${room.id}-${room.is_configured}`}
          room={room} tables={tables.filter((table) => table.room_id === room.id)} profiles={profiles}
          busy={busy || !dayReady} onSave={(target, form) => saveRoom(target, form)} onDelete={setDeleteRoom} />)}
      </div>
    </section>}
    {filteredRooms.length === 0 && <p className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">Không có phòng hoặc bàn khớp với bộ lọc.</p>}

    <AlertDialog open={!!deleteRoom} onOpenChange={(open) => !open && setDeleteRoom(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xóa {deleteRoom?.name}?</AlertDialogTitle>
          <AlertDialogDescription>Các bàn trong phòng sẽ bị xóa. Tài khoản đại diện của phòng sẽ trở thành chưa phân bàn.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmDelete}>Xóa phòng</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={newCredentials.length > 0} onOpenChange={(open) => { if (!open) { setNewCredentials([]); router.refresh(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Tài khoản đại diện bàn đã tạo</AlertDialogTitle>
          <AlertDialogDescription>Hãy lưu thông tin đăng nhập này. Mật khẩu chỉ hiển thị một lần.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto text-sm">
          {newCredentials.map((item) => <div key={item.email} className="rounded-lg border p-3">
            <p className="font-semibold">{item.table}</p>
            <p>Email: <span className="font-mono select-all">{item.email}</span></p>
            <p>Mật khẩu: <span className="font-mono select-all">{item.password}</span></p>
          </div>)}
        </div>
        <AlertDialogFooter><AlertDialogAction onClick={() => { setNewCredentials([]); router.refresh(); }}>Đã lưu</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
