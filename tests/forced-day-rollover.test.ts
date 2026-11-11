import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const JUDGE_1 = "00000000-0000-0000-0000-0000000000b2";
const JUDGE_2 = "00000000-0000-0000-0000-0000000000b3";

describe("forced day rollover", () => {
  it("completes every open state with a forced note, preserves results, and empties the live layout", async () => {
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
      const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
      const previousSchema = schema.split("-- Close every unfinished application before archiving")[0];
      expect(previousSchema).not.toBe(schema);
      await db.exec(previousSchema);
      const migration = readFileSync(new URL("../supabase/migrations/20261210_force_complete_on_rollover.sql", import.meta.url), "utf8");
      await db.exec(migration);
      await db.exec(migration);
      await db.exec("grant all on all tables in schema public to authenticated");
      await db.query(`insert into auth.users(id,email)
        values($1,'admin@club.local'),($2,'judge1@club.local'),($3,'judge2@club.local')`, [ADMIN, JUDGE_1, JUDGE_2]);
      await db.query(`insert into public.profiles(id,email,role)
        values($1,'admin@club.local','ADMIN'),($2,'judge1@club.local','INTERVIEWER'),
          ($3,'judge2@club.local','INTERVIEWER')`, [ADMIN, JUDGE_1, JUDGE_2]);
      const roomId = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number)
        values('DE-318','DE','318') returning id`)).rows[0].id;
      const desks = (await db.query<{ id: string }>(`
        insert into public.tables(room_id,name,department,sort_order)
        values($1,'Bàn 1','ND',1),($1,'Bàn 2','ND',2) returning id`, [roomId])).rows;
      await db.query("update public.profiles set table_id=$1 where id=$2", [desks[0].id, JUDGE_1]);
      await db.query("update public.profiles set table_id=$1 where id=$2", [desks[1].id, JUDGE_2]);
      await db.query("update public.rooms set is_configured=true where id=$1", [roomId]);
      const candidates = (await db.query<{ id: string; code: string }>(`
        insert into public.candidates(code,full_name,department,status,shift,table_id,challenge_status,debate_request_status)
        values
          ('FORCE-N','Chưa đến','ND','NOT_ARRIVED',
            to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+1,'DD/MM/YYYY')||' 19:00 (ND)',null,null,null),
          ('FORCE-C','Check-in','ND','CHECKED_IN',null,null,null,null),
          ('FORCE-A','Đã vào bàn','ND','ASSIGNED',null,$2,null,null),
          ('FORCE-I','Đang chấm','ND','INTERVIEWING',null,$1,null,null),
          ('FORCE-X','Vắng','ND','ABSENT',null,null,null,null),
          ('FORCE-D','Chờ Debate','HCTC','CHECKED_IN',null,$1,'WAITING','PENDING'),
          ('FORCE-DONE','Đã xong','ND','COMPLETED',null,$1,null,null)
        returning id,code`, [desks[0].id, desks[1].id])).rows;
      const byCode = new Map(candidates.map((row) => [row.code, row.id]));
      await db.query("update public.tables set status='INTERVIEWING',current_candidate_id=$1,started_at=now() where id=$2",
        [byCode.get("FORCE-I"), desks[0].id]);
      await db.query("update public.tables set status='ASSIGNED',current_candidate_id=$1,assigned_at=now() where id=$2",
        [byCode.get("FORCE-A"), desks[1].id]);
      await db.query(`insert into public.evaluations(candidate_id,table_id,comment,scores,average_score)
        values($1,$2,'Nhận xét đã chấm','{}'::jsonb,7.5),($3,$2,'Kết quả cũ','{}'::jsonb,8)`,
        [byCode.get("FORCE-D"), desks[0].id, byCode.get("FORCE-DONE")]);
      await db.query(`insert into public.schedule_requests(candidate_id,kind,reason)
        values($1,'RESCHEDULE','Đổi lịch')`, [byCode.get("FORCE-C")]);
      await db.query(`insert into public.display_calls(candidate_id,table_id,department,display_name,display_code,room_label)
        values($1,$2,'ND','Đang chấm','FORCE-I','DE-318 - Bàn 1')`, [byCode.get("FORCE-I"), desks[0].id]);
      const yesterday = (await db.query<{ day: string }>(`
        update public.interview_day_state set day=day-1 where id='main' returning day`)).rows[0].day;

      await db.exec(`set request.jwt.claim.sub='${ADMIN}'; set role authenticated`);
      try {
        await db.query("select public.ensure_interview_day()");
        expect((await db.query<{ id: string }>("select id from public.rooms")).rows).toHaveLength(0);
      } finally {
        await db.exec("reset role");
      }
      const result = (await db.query<{
        code: string; status: string; challenge_status: string | null;
        debate_request_status: string | null; interview_note: string | null;
        comment: string | null; challenge_comment: string | null; average_score: number | null;
      }>(`select c.code,c.status::text,c.challenge_status,c.debate_request_status,
        c.interview_note,e.comment,e.challenge_comment,e.average_score
        from public.candidates c left join public.evaluations e on e.candidate_id=c.id
        order by c.code`)).rows;
      for (const row of result.filter((item) => item.code !== "FORCE-DONE")) {
        expect(row.status).toBe("COMPLETED");
        expect(row.interview_note).toContain("Cưỡng chế");
      }
      expect(result.find((row) => row.code === "FORCE-N")?.average_score).toBeNull();
      expect(result.find((row) => row.code === "FORCE-D")).toMatchObject({
        challenge_status: "COMPLETED", debate_request_status: null, average_score: "7.50",
      });
      expect(result.find((row) => row.code === "FORCE-D")?.challenge_comment).toContain("Cưỡng chế");
      expect(result.find((row) => row.code === "FORCE-D")?.comment).toBe("Nhận xét đã chấm");
      expect(result.find((row) => row.code === "FORCE-DONE")?.interview_note).toBeNull();
      expect(result.find((row) => row.code === "FORCE-DONE")?.comment).toBe("Kết quả cũ");
      expect((await db.query<{ status: string }>("select status from public.schedule_requests")).rows[0].status).toBe("RESOLVED");
      expect((await db.query("select id from public.display_calls")).rows).toHaveLength(0);
      expect((await db.query<{ status: string; archived_at: string | null }>(
        "select status::text,archived_at from public.tables where id=$1", [desks[0].id])).rows[0]).toMatchObject({
        status: "AVAILABLE",
      });
      expect((await db.query<{ rooms: Array<{ id: string }> }>(
        "select rooms from public.interview_day_plans where day=$1", [yesterday])).rows[0].rooms[0].id).toBe(roomId);

      // The Admin's same-day reset uses the same forced completion path.
      const todayRoom = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number)
        values('DE-319','DE','319') returning id`)).rows[0].id;
      await db.query("insert into public.tables(room_id,name,department) values($1,'Bàn 1','ND')", [todayRoom]);
      const todayCandidate = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status)
        values('FORCE-TODAY','Đợi hôm nay','ND','CHECKED_IN') returning id`)).rows[0].id;
      await db.exec(`set request.jwt.claim.sub='${ADMIN}'; set role authenticated`);
      try {
        await db.query("select public.reset_today_interview_rooms()");
      } finally {
        await db.exec("reset role");
      }
      expect((await db.query<{ status: string; interview_note: string }>(
        "select status::text,interview_note from public.candidates where id=$1", [todayCandidate])).rows[0])
        .toMatchObject({ status: "COMPLETED", interview_note: expect.stringContaining("Cưỡng chế") });
      expect((await db.query("select id from public.rooms where archived_at is null")).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
