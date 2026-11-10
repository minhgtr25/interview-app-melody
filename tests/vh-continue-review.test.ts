import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const JUDGE = "00000000-0000-0000-0000-0000000000e1";
const OTHER_JUDGE = "00000000-0000-0000-0000-0000000000e2";

describe("Văn hoá external challenge", () => {
  it("returns a waiting candidate to the same review desk repeatedly, then completes only after challenge", async () => {
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
      await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
      const migration = readFileSync(new URL("../supabase/migrations/20261206_vh_continue_review.sql", import.meta.url), "utf8");
      await db.exec(migration);
      await db.exec(migration);
      const [{ id: roomId }] = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number,external_challenge)
        values('DE-319','DE','319',true) returning id
      `)).rows;
      const [{ id: tableId }] = (await db.query<{ id: string }>(`
        insert into public.tables(room_id,name,department) values($1,'Bàn Văn hoá','VH') returning id
      `, [roomId])).rows;
      await db.query("insert into auth.users(id,email) values($1,'vh@club.local'),($2,'other@club.local')", [JUDGE, OTHER_JUDGE]);
      await db.query(`insert into public.profiles(id,email,full_name,role,table_id)
        values($1,'vh@club.local','Giám khảo VH','INTERVIEWER',$2),
              ($3,'other@club.local','Giám khảo khác','INTERVIEWER',null)`, [JUDGE, tableId, OTHER_JUDGE]);
      await db.query("update public.rooms set is_configured=true where id=$1", [roomId]);
      const [{ id: candidateId }] = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status,table_id)
        values('VH-REPEAT','Thí sinh Văn hoá','VH','ASSIGNED',$1) returning id
      `, [tableId])).rows;
      await db.query("update public.tables set status='ASSIGNED',current_candidate_id=$1 where id=$2", [candidateId, tableId]);
      const criteria = (await db.query<{ id: string; max_score: number }>(
        "select id,max_score from public.rubric_criteria where active",
      )).rows;
      const scores = JSON.stringify(Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.max_score])));
      const asUser = async (id: string, sql: string, params: unknown[]) => {
        await db.exec(`set request.jwt.claim.sub='${id}'; set role authenticated`);
        try { return await db.query(sql, params); }
        finally { await db.exec("reset role"); }
      };

      await asUser(JUDGE, "select public.start_interview($1)", [tableId]);
      await asUser(JUDGE, "select public.submit_evaluation($1,$2::jsonb,$3)", [tableId, scores, "Nhận xét đầu"]);
      await expect(asUser(OTHER_JUDGE, "select public.continue_vh_review($1)", [candidateId]))
        .rejects.toThrow(/không phụ trách/);
      await asUser(JUDGE, "select public.continue_vh_review($1)", [candidateId]);
      await expect(asUser(JUDGE, "select public.finish_external_challenge($1)", [candidateId]))
        .rejects.toThrow(/Chỉ xác nhận/);
      await expect(asUser(JUDGE, "select public.continue_vh_review($1)", [candidateId]))
        .rejects.toThrow(/Bàn đang bận/);
      const returned = (await db.query<{ status: string; challenge_status: string | null }>(
        "select status,challenge_status from public.candidates where id=$1", [candidateId],
      )).rows[0];
      expect(returned).toEqual({ status: "ASSIGNED", challenge_status: null });
      await asUser(JUDGE, "select public.start_interview($1)", [tableId]);
      await asUser(JUDGE, "select public.submit_evaluation($1,$2::jsonb,$3)", [tableId, scores, "Nhận xét bổ sung"]);
      const waiting = (await db.query<{ status: string; challenge_status: string }>(
        "select status,challenge_status from public.candidates where id=$1", [candidateId],
      )).rows[0];
      expect(waiting).toEqual({ status: "CHECKED_IN", challenge_status: "WAITING" });
      const evaluation = (await db.query<{ comment: string; count: string }>(`
        select max(comment) as comment,count(*)::text as count from public.evaluations where candidate_id=$1
      `, [candidateId])).rows[0];
      expect(evaluation).toEqual({ comment: "Nhận xét bổ sung", count: "1" });

      await asUser(JUDGE, "select public.continue_vh_review($1)", [candidateId]);
      await asUser(JUDGE, "select public.start_interview($1)", [tableId]);
      await asUser(JUDGE, "select public.submit_evaluation($1,$2::jsonb,$3)", [tableId, scores, "Nhận xét cuối"]);
      await asUser(JUDGE, "select public.finish_external_challenge($1)", [candidateId]);
      const completed = (await db.query<{ status: string; challenge_status: string }>(
        "select status,challenge_status from public.candidates where id=$1", [candidateId],
      )).rows[0];
      expect(completed).toEqual({ status: "COMPLETED", challenge_status: "COMPLETED" });
      await expect(asUser(JUDGE, "select public.continue_vh_review($1)", [candidateId]))
        .rejects.toThrow(/không còn ở vòng thử thách/);
    } finally {
      await db.close();
    }
  });
});
