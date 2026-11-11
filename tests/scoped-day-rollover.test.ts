import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const ADMIN = "00000000-0000-0000-0000-0000000000c1";
const FORCE_NOTE = "Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026";

describe("day-scoped absence rollover", () => {
  it("marks missed interviews absent, advances them day by day, and leaves next-day applicants untouched", async () => {
    const db = new PGlite();
    let phase = "bootstrap";
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
      const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
      await db.exec(schema.split("-- Save yesterday's layout, then start the new Hanoi calendar day")[0]);
      phase = "apply migrations";
      for (const filename of [
        "20261209_reset_rooms_each_day.sql",
        "20261212_rollback_forced_day_rollover.sql",
        "20261213_restore_nov11_candidates.sql",
        "20261214_force_complete_only_closed_day.sql",
        "20261215_absent_after_interview_day.sql",
      ]) {
        await db.exec(readFileSync(new URL(`../supabase/migrations/${filename}`, import.meta.url), "utf8"));
      }
      await db.query("insert into auth.users(id,email) values($1,'admin@club.local')", [ADMIN]);
      phase = "insert admin profile";
      await db.query("insert into public.profiles(id,email,role) values($1,'admin@club.local','ADMIN')", [ADMIN]);
      await db.query(`insert into public.event_interview_days(day) values
        (date '2026-11-10'),(date '2026-11-11'),(date '2026-11-12') on conflict do nothing`);

      phase = "insert candidate fixtures";
      const candidates = (await db.query<{ id: string; code: string }>(`
        insert into public.candidates(code,full_name,department,status,shift,challenge_status,interview_note)
        values
          ('OLD-DAY','Old day','ND','NOT_ARRIVED','10/11/2026 18:00 (ND)',null,null),
          ('NEXT-DAY','Next day','ND','NOT_ARRIVED','11/11/2026 18:00 (ND)',null,null),
          ('RESTORE','Wrongly completed','HCTC','COMPLETED','11/11/2026 19:00 (HCTC)','COMPLETED',
            $1||' · Trạng thái trước: Đã check-in, thử thách WAITING'),
          ('PLACEHOLDER','Wrong placeholder','ND','COMPLETED','11/11/2026 20:00 (ND)',null,
            $1||' · Trạng thái trước: Chưa đến')
        returning id,code`, [FORCE_NOTE])).rows;
      const byCode = new Map(candidates.map((candidate) => [candidate.code, candidate.id]));
      await db.query(`insert into public.evaluations(candidate_id,comment,scores,average_score)
        values($1,'Nhận xét chưa chấm','{}'::jsonb,null)`, [byCode.get("OLD-DAY")]);
      await db.query(`insert into public.evaluations(candidate_id,comment,scores,average_score,challenge_comment,challenge_ended_at)
        values($1,'Real first-round review','{}'::jsonb,6.6,$2,now()),
          ($3,$4,'{}'::jsonb,null,null,null)`, [
        byCode.get("RESTORE"), FORCE_NOTE + " · Trạng thái trước: Đã check-in, thử thách WAITING",
        byCode.get("PLACEHOLDER"), FORCE_NOTE + " · Trạng thái trước: Chưa đến",
      ]);

      phase = "restore Nov 11 candidates";
      await db.exec(readFileSync(new URL("../supabase/migrations/20261213_restore_nov11_candidates.sql", import.meta.url), "utf8"));
      const restored = (await db.query<{ code: string; status: string; challenge_status: string | null; debate_request_status: string | null; interview_note: string | null }>(`
        select code,status::text,challenge_status,debate_request_status,interview_note
        from public.candidates where code in ('RESTORE','PLACEHOLDER') order by code`)).rows;
      expect(restored.find((row) => row.code === "RESTORE")).toMatchObject({
        status: "CHECKED_IN", challenge_status: "WAITING", debate_request_status: "WAITING", interview_note: null,
      });
      expect((await db.query("select id from public.evaluations where candidate_id=$1", [byCode.get("PLACEHOLDER")])).rows).toHaveLength(0);
      expect((await db.query<{ comment: string; average_score: string }>(
        "select comment,average_score from public.evaluations where candidate_id=$1", [byCode.get("RESTORE")])).rows[0])
        .toMatchObject({ comment: "Real first-round review", average_score: "6.60" });

      phase = "close Nov 10 and advance eligible absences to Nov 11";
      await db.query("update public.interview_day_state set day=date '2026-11-10' where id='main'");
      await db.query("select public._force_complete_day_candidates(date '2026-11-10','Kết thúc ngày 10/11/2026')");
      await db.query("update public.interview_day_state set day=date '2026-11-11' where id='main'");
      let states = (await db.query<{ code: string; status: string; shift: string }>(`
        select code,status::text,shift from public.candidates where code in ('OLD-DAY','NEXT-DAY','RESTORE')`)).rows;
      expect(states.find((row) => row.code === "OLD-DAY")).toMatchObject({
        status: "NOT_ARRIVED", shift: "11/11/2026 18:00 (ND)",
      });
      expect(states.find((row) => row.code === "NEXT-DAY")?.status).toBe("NOT_ARRIVED");
      expect(states.find((row) => row.code === "RESTORE")?.status).toBe("CHECKED_IN");

      phase = "close Nov 11 and advance absences to Nov 12";
      await db.query("select public._force_complete_day_candidates(date '2026-11-11','Kết thúc ngày 11/11/2026')");
      await db.query("update public.interview_day_state set day=date '2026-11-12' where id='main'");
      states = (await db.query<{ code: string; status: string; shift: string }>(`
        select code,status::text,shift from public.candidates where code in ('OLD-DAY','NEXT-DAY')`)).rows;
      expect(states.every((row) => row.status === "NOT_ARRIVED" && row.shift.startsWith("12/11/2026"))).toBe(true);

      phase = "leave the final missed interview absent";
      await db.query("select public._force_complete_day_candidates(date '2026-11-12','Kết thúc ngày 12/11/2026')");
      await db.query("update public.interview_day_state set day=date '2026-11-13' where id='main'");
      states = (await db.query<{ code: string; status: string }>(`
        select code,status::text from public.candidates where code in ('OLD-DAY','NEXT-DAY')`)).rows;
      expect(states.every((row) => row.status === "ABSENT")).toBe(true);
      expect((await db.query<{ count: string }>(`select count(*)::text as count from public.candidate_day_history
        where candidate_id in (select id from public.candidates where code in ('OLD-DAY','NEXT-DAY'))`)).rows[0].count)
        .toBe("5");
      expect((await db.query(`select id from public.evaluations where candidate_id in
        (select id from public.candidates where code in ('OLD-DAY','NEXT-DAY'))`)).rows).toHaveLength(0);
    } catch (error) {
      throw new Error(`${phase}: ${String(error)}`, { cause: error });
    } finally {
      await db.close();
    }
  });
});
