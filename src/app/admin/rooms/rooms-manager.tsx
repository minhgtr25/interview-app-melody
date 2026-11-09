"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BuildingRadio } from "@/components/building-radio";
import { DepartmentRadio } from "@/components/department-radio";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";
import { BUILDINGS, isBuildingCode, isRoomNumber, roomCode, type BuildingCode } from "@/lib/rooms";
import { Input } from "@/components/ui/input";
import { DEPARTMENTS, isDepartmentCode, type DepartmentCode } from "@/lib/departments";
import type { InterviewTable, Profile, Room } from "@/lib/types";
import { assignRoomTableAccounts, createTableAccount, deleteAccount } from "@/app/admin/actions";
import { SPECIALIZATIONS_BY_DEPARTMENT, isSpecializedDepartment, isSpecializationForDepartment, specializationLabel, type SpecializationCode } from "@/lib/specializations";
import { dayLabel, todayInVietnam } from "@/lib/interview-days";

type TableSetup = { department: DepartmentCode | ""; specialization: SpecializationCode | ""; createAccount: boolean; judgeId: string };
type RoomForm = {
  building: BuildingCode | "";
  number: string;
  count: 1 | 2 | 3 | 4;
  isChallenge: boolean;
  externalChallenge: boolean;
  tables: TableSetup[];
};

const emptyTable = (): TableSetup => ({ department: "", specialization: "", createAccount: true, judgeId: "" });
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
        onChange={(event) => setForm({ ...form, isChallenge: event.target.checked, externalChallenge: false })} />
      <span><span className="block font-semibold">HCTC · Phòng Debate cho vòng thử thách</span>
        <span className="text-muted-foreground">Tạo tài khoản riêng cho Giám khảo Debate. Điều phối chỉ theo dõi; Giám khảo Debate nhận và chốt thí sinh.</span></span>
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={table.createAccount} disabled={disabled}
            onChange={(event) => changeTable(index, { createAccount: event.target.checked, judgeId: "" })} />
          {form.isChallenge ? "Tạo tài khoản Giám khảo Debate cho bàn" : "Tạo tài khoản đại diện cho bàn"}
        </label>
        {!table.createAccount && <label className="grid gap-1 text-sm">Tài khoản đại diện có sẵn
          <select aria-label={`Tài khoản đại diện Bàn ${index + 1}`} className="h-9 rounded-lg border border-input bg-background px-2"
            value={table.judgeId} disabled={disabled} onChange={(event) => changeTable(index, { judgeId: event.target.value })}>
            <option value="">Chọn tài khoản</option>
            {judges.filter((judge) => occupiedExistingDeskCount === undefined || index < occupiedExistingDeskCount || !judge.table_id)
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
      createAccount: !profiles.some((profile) => profile.role === "INTERVIEWER" && profile.table_id === sorted[index]?.id),
      judgeId: profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === sorted[index]?.id)?.id ?? "",
    })),
  });
  const [form, setForm] = useState<RoomForm>(currentForm);
  const openEditor = () => { setForm(currentForm()); setEditing(true); };
  const hasOccupiedTables = tables.some((table) => table.status !== "AVAILABLE");
  const roomTableIds = new Set(tables.map((table) => table.id));
  const availableJudges = profiles.filter((profile) => profile.role === "INTERVIEWER" &&
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
          <span className="text-muted-foreground">{profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id)?.full_name || "Chưa có tài khoản đại diện"}</span>
          <Button size="xs" variant="outline" onClick={openEditor} disabled={busy} aria-label={`Cấu hình ${room.name} - ${table.name}`}>
            Cấu hình bàn
          </Button>
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
  const router = useRouter();
  const [newForm, setNewForm] = useState<RoomForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [deleteRoom, setDeleteRoom] = useState<Room | null>(null);
  const [newCredentials, setNewCredentials] = useState<{ table: string; email: string; password: string }[]>([]);
  const supabase = createClient();
  const judges = profiles.filter((profile) => profile.role === "INTERVIEWER");
  const unassignedJudges = judges.filter((judge) => !judge.table_id);
  const dayReady = activeDay === todayInVietnam();

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
    if (form.externalChallenge && selected.some((table) => table.department !== "VH"))
      return toast.error("Chế độ thử thách ngoài phòng chỉ dùng cho Ban Văn hoá");
    const existingIds = selected.filter((table) => !table.createAccount).map((table) => table.judgeId);
    if (new Set(existingIds).size !== existingIds.length)
      return toast.error("Một tài khoản đại diện chỉ được gán cho một bàn");
    const currentTables = existing ? tables.filter((table) => table.room_id === existing.id)
      .sort((a, b) => a.sort_order - b.sort_order) : [];
    const occupiedTables = currentTables.filter((table) => table.status !== "AVAILABLE");
    const addOnlyWhileOccupied = occupiedTables.length > 0;
    if (addOnlyWhileOccupied) {
      const existingDeskChanged = currentTables.some((table, index) => {
        const setup = selected[index];
        const judge = profiles.find((profile) => profile.role === "INTERVIEWER" && profile.table_id === table.id);
        return !setup || setup.department !== table.department || setup.specialization !== table.specialization || setup.createAccount || setup.judgeId !== judge?.id;
      });
      if (!existing || selected.length <= currentTables.length ||
        form.building !== existing.building_code || form.number !== existing.room_number ||
        form.isChallenge !== existing.is_challenge || form.externalChallenge !== (existing.external_challenge ?? false) || existingDeskChanged) {
        return toast.error("Phòng đang có bàn bận: chỉ có thể tăng số bàn và giữ nguyên thông tin phòng, Ban, tài khoản của các bàn hiện tại.");
      }
    }
    const currentIds = new Set(currentTables.map((table) => table.id));
    if (selected.some((table) => !table.createAccount && !judges.some((judge) => judge.id === table.judgeId &&
      (!judge.table_id || currentIds.has(judge.table_id)))))
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
        .map((table, index) => ({ tableId: resultIds[firstDeskToProcess + index], profileId: table.judgeId }))
        .filter((item) => !!item.profileId);
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
      <RoomFields form={newForm} setForm={setNewForm} judges={unassignedJudges} disabled={busy || !dayReady} prefix="new-room" />
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

    {BUILDINGS.map((building) => {
      const buildingRooms = rooms.filter((room) => room.building_code === building.code);
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
    {rooms.some((room) => !room.building_code) && <section className="space-y-3">
      <h3 className="text-base font-semibold">Phòng cũ cần chọn Tòa và Số phòng</h3>
      <div className="grid gap-4 xl:grid-cols-2">
        {rooms.filter((room) => !room.building_code).map((room) => <ExistingRoom key={`${room.id}-${room.is_configured}`}
          room={room} tables={tables.filter((table) => table.room_id === room.id)} profiles={profiles}
          busy={busy || !dayReady} onSave={(target, form) => saveRoom(target, form)} onDelete={setDeleteRoom} />)}
      </div>
    </section>}

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
