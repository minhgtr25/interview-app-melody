/**
 * Chạy supabase/schema.sql trên Postgres thật (PGlite, chạy trong Node) với
 * một lớp giả lập tối thiểu của Supabase (schema auth, auth.uid(), các role,
 * publication realtime), rồi kiểm tra toàn bộ vòng đời thí sinh và RLS.
 */
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The SQL schema is intentionally local and excluded from the public code repository.
// Clones without it can still run the application tests; local workspaces run the full suite.
describe.skipIf(!existsSync(new URL("../supabase/schema.sql", import.meta.url)))("Private Supabase schema", () => {

const SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create publication supabase_realtime;
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

const GRANTS = `
  grant select, insert, update, delete on all tables in schema public to authenticated;
`;

const ADMIN = "00000000-0000-0000-0000-00000000000a";
const CHECKIN = "00000000-0000-0000-0000-00000000000b";
const COORD = "00000000-0000-0000-0000-00000000000c";
const JUDGE = "00000000-0000-0000-0000-00000000000d";
const JUDGE2 = "00000000-0000-0000-0000-00000000000e";
const JUDGE3 = "00000000-0000-0000-0000-00000000000f";
const JUDGE4 = "00000000-0000-0000-0000-000000000010";
const JUDGE5 = "00000000-0000-0000-0000-000000000011";

let db: PGlite;

/** Chạy câu lệnh dưới vai trò `authenticated` với user id cho trước (giống request từ client). */
async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set role authenticated;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

async function superQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  await db.exec("reset role;");
  return (await db.query<T>(sql, params)).rows;
}

let tableA: string;
let tableB: string;
let cand1: string;
let cand2: string;
let crit: { id: string; max_score: number }[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SHIM);
  const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  await db.exec(schema);
  // Project mới: chỉ chạy schema.sql, không chạy các migration cho project cũ.
  await db.exec(schema);
  await db.exec(schema); // Chạy lại không tạo thêm dữ liệu mẫu hoặc lỗi DDL.
  await db.exec(GRANTS);

  const [fresh] = await superQuery<{ rooms: number; tables: number; criteria: number }>(
    "select (select count(*) from public.rooms)::int as rooms, (select count(*) from public.tables)::int as tables, (select count(*) from public.rubric_criteria)::int as criteria"
  );
  expect(fresh).toEqual({ rooms: 0, tables: 0, criteria: 5 });

  const [room] = await superQuery<{ id: string }>(
    "insert into public.rooms (name, building_code, room_number) values ('DE-318', 'DE', '318') returning id"
  );
  await superQuery(
    "insert into public.tables (room_id, name, sort_order) values ($1, 'Bàn 1', 1), ($1, 'Bàn 2', 2), ($1, 'Bàn 3', 3)",
    [room.id]
  );
  const tables = await superQuery<{ id: string }>("select id from public.tables order by sort_order");
  [tableA, tableB] = tables.map((t) => t.id);
  await superQuery("update public.tables set department = case when id = $1 then 'CM' when id = $2 then 'VH' else 'TT' end", [tableA, tableB]);

  await superQuery(
    `insert into auth.users (id, email) values ($1,'a@x'),($2,'c@x'),($3,'co@x'),($4,'j@x'),($5,'j2@x'),($6,'j3@x')`,
    [ADMIN, CHECKIN, COORD, JUDGE, JUDGE2, JUDGE3]
  );
  await superQuery(
    `insert into public.profiles (id, email, full_name, role, table_id) values
      ($1,'a@x','Admin','ADMIN',null),
      ($2,'c@x','Checkin','CHECKIN',null),
      ($3,'co@x','Coord','COORDINATOR',null),
      ($4,'j@x','Judge A','INTERVIEWER',$6),
      ($5,'j2@x','Judge B','INTERVIEWER',$7),
      ($8,'j3@x','Judge C','INTERVIEWER',$9)`,
    [ADMIN, CHECKIN, COORD, JUDGE, JUDGE2, tableA, tableB, JUDGE3, tables[2].id]
  );
  await superQuery("update public.rooms set is_configured = true");
  crit = await superQuery("select id, max_score from public.rubric_criteria where active order by sort_order");
});

describe("Chat và alarm bàn", () => {
  it("chat chỉ hiển thị cho đúng bàn và điều phối", async () => {
    await as(JUDGE, "insert into public.ops_messages (table_id, sender_id, kind, body) values ($1,$2,'CHAT','Cần hỗ trợ')", [tableA, JUDGE]);
    expect((await as(JUDGE, "select id from public.ops_messages where table_id = $1 and kind = 'CHAT'", [tableA])).length).toBe(1);
    expect((await as(JUDGE2, "select id from public.ops_messages where table_id = $1", [tableA])).length).toBe(0);
    expect((await as(COORD, "select id from public.ops_messages where table_id = $1 and kind = 'CHAT'", [tableA])).length).toBe(1);
    await expect(as(JUDGE2, "insert into public.ops_messages (table_id, sender_id, kind, body) values ($1,$2,'CHAT','X')", [tableA, JUDGE2])).rejects.toThrow();
    await expect(as(JUDGE, "insert into public.ops_messages (table_id, sender_id, kind, body) values ($1,$2,'ALARM','X')", [tableA, JUDGE])).rejects.toThrow();
  });

  it("alarm chỉ gửi từ bàn được gán và tối đa một lần mỗi 30 giây", async () => {
    await expect(as(JUDGE2, "select public.send_table_alarm($1)", [tableA])).rejects.toThrow(/phân công/);
    await as(JUDGE, "select public.send_table_alarm($1)", [tableA]);
    await expect(as(JUDGE, "select public.send_table_alarm($1)", [tableA])).rejects.toThrow(/30 giây/);
    expect((await as(COORD, "select id from public.ops_messages where table_id = $1 and kind = 'ALARM'", [tableA])).length).toBe(1);
  });
});

describe("schema.sql", () => {
  it("chỉ tạo 5 tiêu chí; phòng và bàn trong test được tạo riêng", async () => {
    expect((await superQuery("select 1 from public.rooms")).length).toBe(1);
    expect((await superQuery("select 1 from public.tables")).length).toBe(3);
    expect(crit.length).toBe(5);
  });

  it("đăng ký bảng vào publication realtime", async () => {
    const rows = await superQuery<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1"
    );
    expect(rows.map((r) => r.tablename)).toEqual(["candidates", "display_calls", "display_settings", "evaluations", "ops_messages", "rooms", "tables"]);
  });

  it("mã phòng sinh từ Tòa và 3 chữ số, Ban thuộc từng bàn", async () => {
    const [room] = await superQuery<{ name: string; building_code: string; room_number: string; is_configured: boolean }>(
      "select name, building_code, room_number, is_configured from public.rooms limit 1"
    );
    expect(room).toEqual({ name: "DE-318", building_code: "DE", room_number: "318", is_configured: true });
    const departments = await superQuery<{ department: string }>(
      "select department from public.tables order by sort_order"
    );
    expect(departments.map((table) => table.department)).toEqual(["CM", "VH", "TT"]);
    await expect(superQuery("insert into public.rooms (name, building_code, room_number) values ('x','XX','318')"))
      .rejects.toThrow();
    await expect(superQuery("insert into public.rooms (name, building_code, room_number) values ('x','BE','18')"))
      .rejects.toThrow();
    await expect(superQuery("insert into public.rooms (name, building_code, room_number) values ('x','BE','141')"))
      .rejects.toThrow();
    await expect(superQuery("insert into public.rooms (name, building_code, room_number) values ('x','BE','501')"))
      .rejects.toThrow();
    const [limit] = await superQuery<{ name: string }>(
      "insert into public.rooms (name, building_code, room_number) values ('x','BE','140') returning name"
    );
    expect(limit.name).toBe("BE-140");
  });

  it("mỗi bàn chỉ có một tài khoản giám khảo đại diện", async () => {
    await expect(superQuery("update public.profiles set table_id = $1 where id = $2", [tableA, JUDGE2]))
      .rejects.toThrow();
  });
});

describe("RLS", () => {
  it("admin import thí sinh, staff khác không ghi trực tiếp được", async () => {
    const rows = await as<{ id: string }>(
      ADMIN,
      `insert into public.candidates (code, full_name, department) values ('UV1','Nguyễn A','CM'),('UV2','Trần B','VH') returning id`
    );
    [cand1, cand2] = rows.map((r) => r.id);

    await expect(as(CHECKIN, `insert into public.candidates (code, full_name) values ('X','X')`)).rejects.toThrow();
    // UPDATE bị RLS lọc hết -> 0 dòng, trạng thái không đổi
    await as(CHECKIN, `update public.candidates set status = 'COMPLETED' where id = $1`, [cand1]);
    const [c] = await superQuery<{ status: string }>("select status from public.candidates where id = $1", [cand1]);
    expect(c.status).toBe("NOT_ARRIVED");
  });

  it("Check-in bổ sung thí sinh, điểm danh ngay và lưu đúng người tạo", async () => {
    const [candidate] = await as<{
      id: string; code: string; status: string; checked_in_at: string;
      added_by_id: string; added_by_name: string; added_by_email: string; added_by_role: string;
    }>(CHECKIN, "select * from public.add_walk_in_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      ["BS01", "Thí sinh bổ sung", "CM", "0901234567", "bs@example.com", null,
        "HE123456", "K22", "NAM", "https://facebook.com/example"]);
    expect(candidate).toMatchObject({
      code: "BS01", status: "CHECKED_IN", added_by_id: CHECKIN,
      added_by_name: "Checkin", added_by_email: "c@x", added_by_role: "CHECKIN",
    });
    expect(candidate.checked_in_at).toBeTruthy();
    expect((await as(COORD, "select id from public.candidates where id = $1", [candidate.id])).length).toBe(1);
    await as(ADMIN, "insert into public.candidates (code, full_name, department) values ('BS01','Tên được cập nhật','CM') on conflict (code) do update set full_name = excluded.full_name");
    const [afterImport] = await superQuery<{ added_by_id: string; added_by_name: string }>(
      "select added_by_id, added_by_name from public.candidates where id = $1", [candidate.id]
    );
    expect(afterImport).toEqual({ added_by_id: CHECKIN, added_by_name: "Checkin" });
    await expect(as(CHECKIN, "select * from public.add_walk_in_candidate('BS01','Trùng mã','CM')")).rejects.toThrow();
    await expect(as(CHECKIN, "select * from public.add_walk_in_candidate('BS02','Sai Ban','KHAC')")).rejects.toThrow(/Ban/);
    await expect(as(JUDGE, "select * from public.add_walk_in_candidate('BS03','Không có quyền','CM')")).rejects.toThrow(/quyền/);
  });

  it("import form theo MSSV là nguyên tử và giữ mã, trạng thái, Ca khi nhập lại", async () => {
    const first = [{ student_number: "HE234567", full_name: "Thí sinh Form", student_cohort: "K22",
      gender: "NU", phone: "0900000000", email: "form@example.com", facebook_url: null, department: "TT" }];
    await expect(as(CHECKIN, "select public.import_form_candidates($1::jsonb)", [JSON.stringify(first)])).rejects.toThrow(/quyền/);
    await as(ADMIN, "select public.import_form_candidates($1::jsonb)", [JSON.stringify(first)]);
    const [before] = await superQuery<{ code: string }>("select code from public.candidates where student_number = 'HE234567'");
    expect(before.code).toMatch(/^UV-[A-F0-9]{12}$/);
    await superQuery("update public.candidates set status = 'CHECKED_IN', shift = 'Ca đã xác nhận' where student_number = 'HE234567'");
    await as(ADMIN, "select public.import_form_candidates($1::jsonb)", [JSON.stringify([{ ...first[0], full_name: "Tên mới" }])]);
    const [after] = await superQuery<{ code: string; status: string; shift: string; full_name: string }>(
      "select code, status, shift, full_name from public.candidates where student_number = 'HE234567'");
    expect(after).toEqual({ code: before.code, status: "CHECKED_IN", shift: "Ca đã xác nhận", full_name: "Tên mới" });
    const invalid = [first[0], { ...first[0], student_number: "HE234568", email: "other@example.com" },
      { ...first[0], student_number: "BAD", email: "bad@example.com" }];
    await expect(as(ADMIN, "select public.import_form_candidates($1::jsonb)", [JSON.stringify(invalid)])).rejects.toThrow(/MSSV/);
    expect((await superQuery("select id from public.candidates where student_number = 'HE234568'")).length).toBe(0);
  });

  it("người chưa có profile không đọc được gì", async () => {
    const rows = await as("00000000-0000-0000-0000-0000000000ff", "select * from public.candidates");
    expect(rows.length).toBe(0);
  });

  it("người dùng không tự nâng quyền được", async () => {
    await as(CHECKIN, `update public.profiles set role = 'ADMIN' where id = $1`, [CHECKIN]);
    const [p] = await superQuery<{ role: string }>("select role from public.profiles where id = $1", [CHECKIN]);
    expect(p.role).toBe("CHECKIN");
  });

  it("check-in chỉ thấy profile của chính mình", async () => {
    const rows = await as(CHECKIN, "select id from public.profiles");
    expect(rows).toEqual([{ id: CHECKIN }]);
  });
});

describe("Vòng đời thí sinh", () => {
  it("giám khảo không được check-in, check-in không được gán bàn", async () => {
    await expect(as(JUDGE, "select public.check_in_candidate($1)", [cand1])).rejects.toThrow(/quyền/);
    await as(CHECKIN, "select public.check_in_candidate($1)", [cand1]);
    await expect(as(CHECKIN, "select public.assign_candidate($1,$2)", [cand1, tableA])).rejects.toThrow(/quyền/);
  });

  it("không check-in 2 lần", async () => {
    await expect(as(CHECKIN, "select public.check_in_candidate($1)", [cand1])).rejects.toThrow(/đã được check-in/);
  });

  it("không gán thí sinh chưa check-in", async () => {
    await expect(as(COORD, "select public.assign_candidate($1,$2)", [cand2, tableA])).rejects.toThrow(/hàng chờ/);
  });

  it("gán bàn → bàn bận, không gán thêm được", async () => {
    await as(COORD, "select public.assign_candidate($1,$2)", [cand1, tableA]);
    const [call] = await as<{ department: string; display_name: string; display_code: string; room_label: string }>(
      COORD, "select department, display_name, display_code, room_label from public.display_calls where candidate_id = $1", [cand1]
    );
    expect(call).toEqual({ department: "CM", display_name: "Nguyễn A", display_code: "UV1", room_label: "DE-318" });
    expect((await as(JUDGE, "select id from public.display_calls")).length).toBe(0);
    const [t] = await superQuery<{ status: string; current_candidate_id: string }>(
      "select status, current_candidate_id from public.tables where id = $1",
      [tableA]
    );
    expect(t).toEqual({ status: "ASSIGNED", current_candidate_id: cand1 });

    await as(CHECKIN, "select public.check_in_candidate($1)", [cand2]);
    await expect(as(COORD, "select public.assign_candidate($1,$2)", [cand2, tableA])).rejects.toThrow(/đang bận/);
  });

  it("giám khảo bàn khác không thao tác được bàn này", async () => {
    await expect(as(JUDGE2, "select public.start_interview($1)", [tableA])).rejects.toThrow(/phân công/);
  });

  it("trả về hàng chờ giữ nguyên giờ check-in", async () => {
    const [before] = await superQuery<{ checked_in_at: string }>(
      "select checked_in_at from public.candidates where id = $1",
      [cand1]
    );
    await as(JUDGE, "select public.return_to_queue($1)", [tableA]);
    expect((await superQuery("select id from public.display_calls where candidate_id = $1", [cand1])).length).toBe(0);
    const [after] = await superQuery<{ status: string; checked_in_at: string; table_id: string | null }>(
      "select status, checked_in_at, table_id from public.candidates where id = $1",
      [cand1]
    );
    expect(after.status).toBe("CHECKED_IN");
    expect(after.table_id).toBeNull();
    expect(String(after.checked_in_at)).toBe(String(before.checked_in_at));
    const [t] = await superQuery<{ status: string }>("select status from public.tables where id = $1", [tableA]);
    expect(t.status).toBe("AVAILABLE");
  });

  it("chỉ gán thí sinh vào bàn cùng Ban", async () => {
    await expect(as(COORD, "select public.assign_candidate($1,$2)", [cand2, tableA])).rejects.toThrow(/không khớp/);
    const [newRoom] = await superQuery<{ id: string }>(
      "insert into public.rooms (name, building_code, room_number) values ('temporary', 'DE', '319') returning id"
    );
    const [newTable] = await superQuery<{ id: string; department: string }>(
      "insert into public.tables (room_id, name, department) values ($1, 'Bàn 1', 'CM') returning id, department", [newRoom.id]
    );
    const [secondTable] = await superQuery<{ id: string }>(
      "insert into public.tables (room_id, name, department) values ($1, 'Bàn 2', 'CM') returning id", [newRoom.id]
    );
    expect(newTable.department).toBe("CM");
    await expect(superQuery("update public.rooms set is_configured = true where id = $1", [newRoom.id]))
      .rejects.toThrow(/tài khoản đại diện/);
    await superQuery("insert into auth.users (id, email) values ($1,'j4@x'),($2,'j5@x')", [JUDGE4, JUDGE5]);
    await superQuery(
      "insert into public.profiles (id,email,full_name,role,table_id) values ($1,'j4@x','Judge D','INTERVIEWER',$3),($2,'j5@x','Judge E','INTERVIEWER',$4)",
      [JUDGE4, JUDGE5, newTable.id, secondTable.id]
    );
    await superQuery("update public.rooms set is_configured = true where id = $1", [newRoom.id]);
    await as(COORD, "select public.assign_candidate($1,$2)", [cand1, newTable.id]);
    await as(COORD, "select public.return_to_queue($1)", [newTable.id]);
    await expect(as(COORD, "select public.assign_candidate($1,$2)", [cand2, secondTable.id])).rejects.toThrow(/không khớp/);
    const [unconfiguredRoom] = await superQuery<{ id: string }>("insert into public.rooms (name) values ('DE-320') returning id");
    const [unconfiguredTable] = await superQuery<{ id: string }>(
      "insert into public.tables (room_id, name) values ($1, 'Bàn 1') returning id", [unconfiguredRoom.id]
    );
    await expect(as(COORD, "select public.assign_candidate($1,$2)", [cand1, unconfiguredTable.id])).rejects.toThrow(/chưa được kích hoạt/);
  });

  it("bắt đầu → nộp đánh giá → hoàn thành, bàn được giải phóng", async () => {
    await as(COORD, "select public.assign_candidate($1,$2)", [cand1, tableA]);
    await as(JUDGE, "select public.start_interview($1)", [tableA]);

    // Thiếu tiêu chí → lỗi
    await expect(
      as(JUDGE, "select public.submit_evaluation($1, $2::jsonb, 'x')", [tableA, JSON.stringify({ [crit[0].id]: 8 })])
    ).rejects.toThrow(/Chưa chấm/);

    // Điểm vượt mức tối đa → lỗi
    const over = Object.fromEntries(crit.map((c) => [c.id, c.max_score + 1]));
    await expect(
      as(JUDGE, "select public.submit_evaluation($1, $2::jsonb, 'x')", [tableA, JSON.stringify(over)])
    ).rejects.toThrow(/khoảng/);

    const scores = Object.fromEntries(crit.map((c, i) => [c.id, [8, 7, 9, 6, 10][i]]));
    await as(JUDGE, "select public.submit_evaluation($1, $2::jsonb, $3)", [tableA, JSON.stringify(scores), "  Tốt  "]);

    const [e] = await superQuery<{ average_score: string; comment: string; interviewer_name: string; table_label: string; duration_seconds: number }>(
      "select average_score, comment, interviewer_name, table_label, duration_seconds from public.evaluations where candidate_id = $1",
      [cand1]
    );
    expect(Number(e.average_score)).toBe(8);
    expect(e.comment).toBe("Tốt");
    expect(e.interviewer_name).toBe("Judge A");
    expect(e.table_label).toBe("DE-318 - Bàn 1");
    expect(e.duration_seconds).toBeGreaterThanOrEqual(0);

    const [c] = await superQuery<{ status: string }>("select status from public.candidates where id = $1", [cand1]);
    expect(c.status).toBe("COMPLETED");
    const [t] = await superQuery<{ status: string; current_candidate_id: string | null }>(
      "select status, current_candidate_id from public.tables where id = $1",
      [tableA]
    );
    expect(t).toEqual({ status: "AVAILABLE", current_candidate_id: null });
  });

  it("giám khảo chỉ đọc được phiếu của mình", async () => {
    expect((await as(JUDGE, "select id from public.evaluations")).length).toBe(1);
    expect((await as(JUDGE2, "select id from public.evaluations")).length).toBe(0);
    expect((await as(ADMIN, "select id from public.evaluations")).length).toBe(1);
    expect((await as(COORD, "select id from public.evaluations")).length).toBe(1);
    expect((await as(CHECKIN, "select id from public.evaluations")).length).toBe(0);
  });

  it("không đánh vắng thí sinh đã hoàn thành; đánh vắng & check-in lại được", async () => {
    await expect(as(COORD, "select public.mark_absent($1)", [cand1])).rejects.toThrow();
    await as(COORD, "select public.mark_absent($1)", [cand2]);
    await as(CHECKIN, "select public.check_in_candidate($1)", [cand2]);
    const [c] = await superQuery<{ status: string; absent_at: string | null }>(
      "select status, absent_at from public.candidates where id = $1",
      [cand2]
    );
    expect(c).toEqual({ status: "CHECKED_IN", absent_at: null });
  });

  it("admin reset thí sinh: xoá phiếu, về Chưa đến", async () => {
    await expect(as(COORD, "select public.admin_reset_candidate($1)", [cand1])).rejects.toThrow(/quyền/);
    await as(ADMIN, "select public.admin_reset_candidate($1)", [cand1]);
    const [c] = await superQuery<{ status: string }>("select status from public.candidates where id = $1", [cand1]);
    expect(c.status).toBe("NOT_ARRIVED");
    expect((await superQuery("select 1 from public.evaluations where candidate_id = $1", [cand1])).length).toBe(0);
  });

  it("Điều phối chọn họ tên hoặc mã số cho màn hình TV", async () => {
    expect((await as<{ identity_mode: string }>(COORD, "select identity_mode from public.display_settings where id = 'main'"))[0].identity_mode).toBe("NAME");
    await as(COORD, "update public.display_settings set identity_mode = 'CODE' where id = 'main'");
    expect((await as<{ identity_mode: string }>(ADMIN, "select identity_mode from public.display_settings where id = 'main'"))[0].identity_mode).toBe("CODE");
    expect((await as(JUDGE, "select id from public.display_settings")).length).toBe(0);
    await expect(as(JUDGE, "update public.display_settings set identity_mode = 'NAME' where id = 'main' returning id")).resolves.toEqual([]);
  });

  it("TV chỉ hiển thị người được gọi cho tới khi bắt đầu phỏng vấn", async () => {
    const scores = Object.fromEntries(crit.map((item) => [item.id, 7]));
    const [candidate] = await superQuery<{ id: string }>(
      "insert into public.candidates (code, full_name, department, status) values ('TV1','Thí sinh TV','CM','CHECKED_IN') returning id"
    );
    await as(COORD, "select public.assign_candidate($1,$2)", [candidate.id, tableA]);
    expect((await superQuery("select id from public.display_calls where candidate_id = $1", [candidate.id])).length).toBe(1);
    await as(JUDGE, "select public.start_interview($1)", [tableA]);
    expect((await superQuery("select id from public.display_calls where candidate_id = $1", [candidate.id])).length).toBe(0);
    await as(JUDGE, "select public.submit_evaluation($1,$2::jsonb,'')", [tableA, JSON.stringify(scores)]);
    expect((await superQuery("select id from public.display_calls where candidate_id = $1", [candidate.id])).length).toBe(0);
  });

  it("anon không gọi được RPC", async () => {
    await db.exec("reset role; set request.jwt.claim.sub = ''; set role anon;");
    await expect(db.query("select public.check_in_candidate($1)", [cand2])).rejects.toThrow();
    await db.exec("reset role;");
  });

  it("migration màn hình TV có thể chạy lại mà giữ dữ liệu", async () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261104_waiting_display.sql", import.meta.url), "utf8");
    const before = await superQuery<{ count: number }>("select count(*)::int as count from public.display_calls");
    await db.exec(migration);
    await db.exec(migration);
    const after = await superQuery<{ count: number }>("select count(*)::int as count from public.display_calls");
    expect(after[0].count).toBe(before[0].count);
  });

  it("migration gỡ tên cũ trên TV và giữ quy tắc khi bắt đầu phỏng vấn", async () => {
    await superQuery(
      "insert into public.display_calls (candidate_id, department, display_name, display_code, room_label) select id, 'CM', full_name, code, 'DE-318' from public.candidates where code = 'TV1'"
    );
    const migration = readFileSync(new URL("../supabase/migrations/20261105_display_clear_on_start.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    expect((await superQuery("select id from public.display_calls where display_code = 'TV1'")).length).toBe(0);
  });

  it("migration bổ sung Check-in có thể chạy lại và giữ người tạo", async () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261105_checkin_walkins.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const [candidate] = await superQuery<{ added_by_name: string }>("select added_by_name from public.candidates where code = 'BS01'");
    expect(candidate.added_by_name).toBe("Checkin");
  });

  it("migration Check-in và lịch sử bàn có thể chạy lại mà không mất dữ liệu", async () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261105_checkin_history.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    expect((await as(COORD, "select id from public.evaluations")).length).toBeGreaterThan(0);
    const [candidate] = await superQuery<{ added_by_name: string }>("select added_by_name from public.candidates where code = 'BS01'");
    expect(candidate.added_by_name).toBe("Checkin");
  });

  it("cổng chốt kết quả khóa mã sai, chỉ chốt đúng Ban đã hoàn thành và lưu lịch sử", async () => {
    const [portal] = await superQuery<{ generation: string }>(
      "insert into public.review_portals (department, active, code_hash) values ('CM', true, 'correct-hash') returning generation"
    );
    expect((await as(COORD, "select department from public.review_portals")).length).toBe(0);
    for (let i = 0; i < 10; i++) {
      expect((await superQuery<{ value: string | null }>(
        "select public.verify_review_portal('CM', 'wrong-hash') as value"
      ))[0].value).toBeNull();
    }
    expect((await superQuery<{ value: string | null }>(
      "select public.verify_review_portal('CM', 'correct-hash') as value"
    ))[0].value).toBeNull();
    await superQuery("update public.review_portals set locked_until = null where department = 'CM'");
    expect((await superQuery<{ value: string }>(
      "select public.verify_review_portal('CM', 'correct-hash') as value"
    ))[0].value).toBe(portal.generation);
    const [completed] = await superQuery<{ id: string }>("select id from public.candidates where code = 'TV1'");
    const [waiting] = await superQuery<{ id: string }>("select id from public.candidates where code = 'BS01'");
    await expect(superQuery(
      "insert into public.review_decisions (candidate_id, department, decision, portal_generation) values ($1,'CM','PASS',$2)",
      [waiting.id, portal.generation]
    )).rejects.toThrow(/hoàn thành/);
    await expect(superQuery(
      "insert into public.review_decisions (candidate_id, department, decision, portal_generation) values ($1,'VH','PASS',$2)",
      [completed.id, portal.generation]
    )).rejects.toThrow(/đúng Ban/);
    await superQuery(
      "insert into public.review_decisions (candidate_id, department, decision, note, portal_generation) values ($1,'CM','CONSIDER','Cần trao đổi',$2)",
      [completed.id, portal.generation]
    );
    expect((await as(COORD, "select id from public.review_decisions")).length).toBe(0);
    await expect(as(COORD, "select public.verify_review_portal('CM', 'correct-hash')")).rejects.toThrow();
    await superQuery("update public.review_decisions set decision = 'PASS', note = 'Đạt' where candidate_id = $1", [completed.id]);
    expect((await superQuery("select id from public.review_decision_events where candidate_id = $1", [completed.id])).length).toBe(2);
    await superQuery("update public.review_portals set active = false where department = 'CM'");
    await expect(superQuery("update public.review_decisions set decision = 'FAIL' where candidate_id = $1", [completed.id]))
      .rejects.toThrow(/đã đóng/);
  });

  it("migration cổng chấm có thể chạy lại và giữ quyết định", async () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261105_department_reviews.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    expect((await superQuery("select id from public.review_decisions")).length).toBe(1);
  });

  it("đưa thí sinh về Chưa đến sẽ xóa quyết định cũ nhưng giữ nhật ký", async () => {
    const [candidate] = await superQuery<{ id: string }>("select id from public.candidates where code = 'TV1'");
    await as(ADMIN, "select public.admin_reset_candidate($1)", [candidate.id]);
    expect((await superQuery("select id from public.review_decisions where candidate_id = $1", [candidate.id])).length).toBe(0);
    expect((await superQuery("select id from public.review_decision_events where candidate_id = $1", [candidate.id])).length).toBe(2);
  });

  it("migration hồ sơ cá nhân chạy lại được sau các migration cũ", async () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261108_candidate_personal_fields.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const [candidate] = await superQuery<{ student_number: string; gender: string }>(
      "select student_number, gender from public.candidates where code = 'BS01'");
    expect(candidate).toEqual({ student_number: "HE123456", gender: "NAM" });
  });
});

});
