import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const COORDINATOR = "00000000-0000-0000-0000-0000000000a2";
const JUDGE = "00000000-0000-0000-0000-0000000000a3";

describe("coordinator specialization selection", () => {
  it("requires a valid specialization matching the desk and saves it on assignment", async () => {
    const db = new PGlite();
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create publication supabase_realtime;
    `);
    await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
    const migration = readFileSync(new URL("../supabase/migrations/20261204_coordinator_selects_specialization.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);

    const [{ id: roomId }] = (await db.query<{ id: string }>(`
      insert into public.rooms(name,building_code,room_number) values('CM Test','DE','318') returning id
    `)).rows;
    const [{ id: tableId }] = (await db.query<{ id: string }>(`
      insert into public.tables(room_id,name,department,specialization)
      values($1,'Hát','CM','HAT') returning id
    `, [roomId])).rows;
    await db.query("insert into auth.users(id,email) values($1,'coord@example.test'),($2,'judge@example.test')", [COORDINATOR, JUDGE]);
    await db.query(`
      insert into public.profiles(id,email,full_name,role,table_id) values
        ($1,'coord@example.test','Coordinator','COORDINATOR',null),
        ($2,'judge@example.test','Judge','INTERVIEWER',$3)
    `, [COORDINATOR, JUDGE, tableId]);
    await db.query("update public.rooms set is_configured=true where id=$1", [roomId]);
    const [{ id: candidateId }] = (await db.query<{ id: string }>(`
      insert into public.candidates(code,full_name,department,status)
      values('CM-QUEUE','Queued candidate','CM','CHECKED_IN') returning id
    `)).rows;

    await db.exec(`set request.jwt.claim.sub = '${COORDINATOR}'; set role authenticated;`);
    await expect(db.query("select public.assign_candidate($1,$2,$3)", [candidateId, tableId, null]))
      .rejects.toThrow(/chọn ngạch Chuyên Môn/i);
    await expect(db.query("select public.assign_candidate($1,$2,$3)", [candidateId, tableId, "RAP"]))
      .rejects.toThrow(/không khớp ngạch/i);
    await db.query("select public.assign_candidate($1,$2,$3)", [candidateId, tableId, "HAT"]);
    await db.exec("reset role;");

    const [{ specialization, status }] = (await db.query<{ specialization: string; status: string }>(`
      select specialization,status::text from public.candidates where id=$1
    `, [candidateId])).rows;
    expect({ specialization, status }).toEqual({ specialization: "HAT", status: "ASSIGNED" });
    await db.close();
  });
});
