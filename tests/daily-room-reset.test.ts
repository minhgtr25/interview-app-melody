import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const JUDGE = "00000000-0000-0000-0000-0000000000a2";

describe("daily room reset", () => {
  it("archives yesterday's desks and lets Admin build today's layout from scratch", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create schema auth;
        create table auth.users (id uuid primary key, email text);
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create publication supabase_realtime;
        grant usage on schema public to authenticated;
        grant usage on schema auth to authenticated;
        grant execute on function auth.uid() to authenticated;
      `);
      const completeSchema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
      const previousSchema = completeSchema.split("-- Save yesterday's layout, then start the new Hanoi calendar day")[0];
      expect(previousSchema).not.toBe(completeSchema);
      await db.exec(previousSchema);
      const migration = readFileSync(new URL("../supabase/migrations/20261209_reset_rooms_each_day.sql", import.meta.url), "utf8");
      await db.exec(migration);
      await db.exec(migration);
      await db.exec("grant all on all tables in schema public to authenticated");
      await db.query("insert into auth.users(id,email) values($1,'admin@club.local'),($2,'judge@club.local')", [ADMIN, JUDGE]);
      await db.query(`insert into public.profiles(id,email,role)
        values($1,'admin@club.local','ADMIN'),($2,'judge@club.local','INTERVIEWER')`, [ADMIN, JUDGE]);
      const oldRoom = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number)
        values('DE-318','DE','318') returning id`)).rows[0].id;
      const oldDesk = (await db.query<{ id: string }>(`
        insert into public.tables(room_id,name,department)
        values($1,'Bàn 1','ND') returning id`, [oldRoom])).rows[0].id;
      await db.query("update public.profiles set table_id=$1 where id=$2", [oldDesk, JUDGE]);
      await db.query("update public.rooms set is_configured=true where id=$1", [oldRoom]);
      const candidate = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status,table_id)
        values('DAY-OLD','Old day candidate','ND','COMPLETED',$1) returning id`, [oldDesk])).rows[0].id;
      await db.query(`insert into public.evaluations(candidate_id,table_id,table_label,comment)
        values($1,$2,'DE-318 - Bàn 1','Đã chấm')`, [candidate, oldDesk]);
      await db.query("update public.tables set status='INTERVIEWING' where id=$1", [oldDesk]);
      const yesterday = (await db.query<{ day: string }>(`
        update public.interview_day_state set day=day-1 where id='main' returning day`)).rows[0].day;

      const asAdmin = async <T>(sql: string, params: unknown[] = []) => {
        await db.exec(`set request.jwt.claim.sub='${ADMIN}'; set role authenticated`);
        try { return (await db.query<T>(sql, params)).rows; }
        finally { await db.exec("reset role"); }
      };
      await expect(asAdmin("select public.ensure_interview_day()")).rejects.toThrow(/hoàn tất mọi ca/);
      expect((await db.query<{ day: string }>("select day from public.interview_day_state where id='main'")).rows[0].day).toEqual(yesterday);
      await db.query("update public.tables set status='AVAILABLE' where id=$1", [oldDesk]);
      await asAdmin("select public.ensure_interview_day()");
      const snapshot = (await db.query<{ rooms: Array<{ name: string; tables: Array<{ name: string; department: string; judges: Array<{ email: string }> }> }> }>(
        "select rooms from public.interview_day_plans where day=$1", [yesterday])).rows[0].rooms;
      expect(snapshot[0]).toMatchObject({ name: "DE-318", tables: [{ name: "Bàn 1", department: "ND", judges: [{ email: "judge@club.local" }] }] });
      expect(await asAdmin("select id from public.rooms")).toHaveLength(0);
      expect(await asAdmin("select id from public.tables")).toHaveLength(0);
      expect((await db.query<{ table_id: string | null }>("select table_id from public.profiles where id=$1", [JUDGE])).rows[0].table_id).toBeNull();
      expect((await db.query<{ table_id: string; comment: string }>(
        "select table_id,comment from public.evaluations where candidate_id=$1", [candidate])).rows[0]).toMatchObject({
        table_id: oldDesk, comment: "Đã chấm",
      });

      const newRoom = (await asAdmin<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number)
        values('DE-318','DE','318') returning id`))[0].id;
      const newDesk = (await asAdmin<{ id: string }>(`
        insert into public.tables(room_id,name,department)
        values($1,'Bàn 1','ND') returning id`, [newRoom]))[0].id;
      await db.query("update public.profiles set table_id=$1 where id=$2", [newDesk, JUDGE]);
      await asAdmin("update public.rooms set is_configured=true where id=$1", [newRoom]);
      expect(await asAdmin<{ id: string }>("select id from public.rooms")).toEqual([{ id: newRoom }]);
      await asAdmin("select public.reset_today_interview_rooms()");
      expect(await asAdmin("select id from public.rooms")).toHaveLength(0);
      const resetSnapshot = (await db.query<{ rooms: Array<{ id: string }> }>(
        "select rooms from public.interview_day_plans where day=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date")).rows[0].rooms;
      expect(resetSnapshot).toMatchObject([{ id: newRoom }]);
      expect((await db.query<{ rooms: Array<{ id: string }> }>(
        "select rooms from public.interview_day_plans where day=$1", [yesterday])).rows[0].rooms[0].id).toBe(oldRoom);
    } finally {
      await db.close();
    }
  });
});
