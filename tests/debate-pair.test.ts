import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const JUDGE = "00000000-0000-0000-0000-0000000000d1";
const JUDGE2 = "00000000-0000-0000-0000-0000000000d2";
const JUDGE3 = "00000000-0000-0000-0000-0000000000d3";
const ADMIN = "00000000-0000-0000-0000-0000000000da";
const INTERVIEWER = "00000000-0000-0000-0000-0000000000db";

describe("Debate pairs", () => {
  it("processes one or two candidates per Debate batch and retains later candidates in the queue", async () => {
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
      await db.exec(readFileSync(new URL("../supabase/migrations/20261203_debate_desks_and_accounts.sql", import.meta.url), "utf8"));
      const textReviewMigration = readFileSync(new URL("../supabase/migrations/20261205_debate_text_reviews.sql", import.meta.url), "utf8");
      await db.exec(textReviewMigration);
      await db.exec(textReviewMigration);
      const singleCandidateMigration = readFileSync(new URL("../supabase/migrations/20261207_single_candidate_debate.sql", import.meta.url), "utf8");
      await db.exec(singleCandidateMigration);
      await db.exec(singleCandidateMigration);
      await db.exec("grant select on all tables in schema public to authenticated");
      await db.exec(`update public.interview_day_state
        set day=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date where id='main'`);
      const [{ id: roomId }] = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number,is_challenge)
        values('DE-318','DE','318',true) returning id
      `)).rows;
      const desks = (await db.query<{ id: string }>(`
        insert into public.tables(room_id,name,sort_order,department)
        values($1,'Bàn 1',1,'HCTC'),($1,'Bàn 2',2,'HCTC') returning id
      `, [roomId])).rows;
      await db.query(`insert into auth.users(id,email) values($1,'debate1@club.local'),($2,'debate2@club.local'),($3,'admin@club.local'),($4,'debate3@club.local')`, [JUDGE, JUDGE2, ADMIN, JUDGE3]);
      await db.query(`insert into public.profiles(id,email,full_name,role)
        values($1,'admin@club.local','Admin','ADMIN')`, [ADMIN]);
      await db.query(`insert into public.profiles(id,email,full_name,role,table_id,is_debate_judge,debate_judge_position)
        values($1,'debate1@club.local','Debate 1','INTERVIEWER',$2,true,1)`, [JUDGE, desks[0].id]);
      await expect(db.query(`update public.rooms set is_configured=true where id=$1`, [roomId]))
        .rejects.toThrow(/Giám khảo Debate/);
      await db.query(`insert into public.profiles(id,email,full_name,role,table_id,is_debate_judge,debate_judge_position)
        values($1,'debate2@club.local','Debate 2','INTERVIEWER',$2,true,1)`, [JUDGE2, desks[1].id]);
      await db.query(`insert into public.profiles(id,email,full_name,role,table_id,is_debate_judge,debate_judge_position)
        values($1,'debate3@club.local','Debate 3','INTERVIEWER',$2,true,2)`, [JUDGE3, desks[0].id]);
      await db.query(`update public.rooms set is_configured=true where id=$1`, [roomId]);

      const candidates = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status,challenge_status,challenge_table_id,debate_request_status,challenge_started_at)
        values('DB1','First','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB2','Second','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB3','Third','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB4','Fourth','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB5','Fifth','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB6','Sixth','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now())
        returning id
      `, [desks[0].id])).rows;
      for (const candidate of candidates) {
        await db.query(`insert into public.evaluations(candidate_id) values($1)`, [candidate.id]);
      }
      await db.query(`update public.evaluations set comment=case when candidate_id=$1 then 'Nhận xét vòng 1 người thứ nhất'
        else 'Nhận xét vòng 1 người thứ hai' end where candidate_id in ($1,$2)`, [candidates[0].id, candidates[1].id]);
      const criteria = (await db.query<{ id: string; max_score: number }>(`
        select id,max_score from public.rubric_criteria where active
      `)).rows;
      const scores = Object.fromEntries(criteria.map((item) => [item.id, item.max_score]));
      const asUser = async (uid: string, sql: string, params: unknown[]) => {
        await db.exec(`set request.jwt.claim.sub='${uid}'; set role authenticated`);
        try { return await db.query(sql, params); }
        finally { await db.exec("reset role"); }
      };
      const act = (uid: string, candidateId: string, deskId: string, action: string) =>
        asUser(uid, `select public.handle_debate_request($1,$2,$3)`, [candidateId, deskId, action]);
      await expect(act(JUDGE3, candidates[0].id, desks[0].id, "ACCEPT"))
        .rejects.toThrow(/phân công/);
      expect((await asUser(JUDGE2, `select id from public.evaluations where candidate_id=$1`,
        [candidates[0].id])).rows).toHaveLength(1);
      const roundOneReviews = (await asUser(JUDGE3, `select comment from public.evaluations
        where candidate_id in ($1,$2) order by comment`, [candidates[0].id, candidates[1].id])).rows as { comment: string }[];
      expect(roundOneReviews).toHaveLength(2);
      await act(JUDGE, candidates[0].id, desks[0].id, "ACCEPT");
      await act(JUDGE, candidates[1].id, desks[0].id, "FORWARD");
      await act(JUDGE2, candidates[1].id, desks[1].id, "REJECT");
      await act(JUDGE, candidates[1].id, desks[0].id, "ACCEPT");
      await expect(act(JUDGE, candidates[2].id, desks[0].id, "ACCEPT"))
        .rejects.toThrow(/đủ 2 thí sinh/);
      await act(JUDGE, candidates[2].id, desks[0].id, "WAIT");
      await act(JUDGE, candidates[3].id, desks[0].id, "WAIT");
      await act(JUDGE, candidates[4].id, desks[0].id, "FORWARD");
      await act(JUDGE, candidates[5].id, desks[0].id, "FORWARD");
      await act(JUDGE2, candidates[4].id, desks[1].id, "ACCEPT");
      await act(JUDGE2, candidates[5].id, desks[1].id, "ACCEPT");
      await asUser(JUDGE2, `select public.start_debate_pair($1)`, [desks[1].id]);
      await asUser(JUDGE2, `select public.confirm_debate_comment($1,$2,'Solo first')`, [desks[1].id, candidates[4].id]);
      await expect(asUser(JUDGE2, `select public.finalize_debate_pair($1,$2)`, [desks[1].id, null]))
        .rejects.toThrow(/Mỗi thí sinh/);
      await asUser(JUDGE2, `select public.confirm_debate_comment($1,$2,'Solo second')`, [desks[1].id, candidates[5].id]);
      await asUser(JUDGE2, `select public.finalize_debate_pair($1,$2)`, [desks[1].id, null]);
      const soloEvaluations = (await db.query<{ challenge_average_score: number | null; challenge_comment: string }>(`
        select challenge_average_score,challenge_comment from public.evaluations
        where candidate_id in ($1,$2) order by candidate_id
      `, [candidates[4].id, candidates[5].id])).rows;
      expect(soloEvaluations.map((row) => row.challenge_average_score)).toEqual([null, null]);
      expect(soloEvaluations.map((row) => row.challenge_comment).sort()).toEqual(["Solo first", "Solo second"]);
      let rows = (await db.query<{ challenge_status: string; debate_batch_number: number | null; debate_request_status: string }>(`
        select challenge_status,debate_batch_number,debate_request_status from public.candidates
        where challenge_table_id=$1 order by code
      `, [desks[0].id])).rows;
      expect(rows.map((row) => row.debate_request_status)).toEqual(["SLOT", "SLOT", "WAITING", "WAITING"]);
      await asUser(JUDGE, `select public.start_debate_pair($1)`, [desks[0].id]);
      await asUser(JUDGE, `select public.confirm_debate_comment($1,$2,'Primary')`, [desks[0].id, candidates[0].id]);
      expect((await asUser(JUDGE3, `select comment from public.debate_judge_reviews where candidate_id=$1`,
        [candidates[0].id])).rows).toMatchObject([{ comment: "Primary" }]);
      await expect(asUser(JUDGE, `select public.confirm_debate_comment($1,$2,'Wrong slot')`,
        [desks[0].id, candidates[1].id])).rejects.toThrow(/vị trí/);
      await expect(asUser(JUDGE3, `select public.confirm_debate_comment($1,$2,'Wrong slot')`,
        [desks[0].id, candidates[0].id])).rejects.toThrow(/vị trí/);
      await expect(asUser(JUDGE, `select public.finalize_debate_pair($1,$2)`,
        [desks[0].id, null])).rejects.toThrow(/Mỗi thí sinh/);
      await asUser(JUDGE3, `select public.confirm_debate_comment($1,$2,'Secondary')`, [desks[0].id, candidates[1].id]);
      await asUser(ADMIN, `select public.admin_confirm_debate_comment($1,$2,$3,'Secondary via Admin')`,
        [desks[0].id, candidates[1].id, JUDGE3]);
      const adminReview = (await db.query<{ judge_id: string; confirmed_by_id: string }>(`
        select judge_id,confirmed_by_id from public.debate_judge_reviews where candidate_id=$1
      `, [candidates[1].id])).rows[0];
      expect(adminReview).toMatchObject({ judge_id: JUDGE3, confirmed_by_id: ADMIN });
      await expect(asUser(JUDGE3, `select public.finalize_debate_pair($1,$2)`,
        [desks[0].id, null])).rejects.toThrow(/Giám khảo Debate 1/);
      await asUser(ADMIN, `select public.finalize_debate_pair($1,$2)`, [desks[0].id, JUDGE]);
      const pairEvaluations = (await db.query<{ candidate_id: string; challenge_average_score: number | null; challenge_comment: string }>(`
        select candidate_id,challenge_average_score,challenge_comment from public.evaluations
        where candidate_id in ($1,$2)
      `, [candidates[0].id, candidates[1].id])).rows;
      expect(pairEvaluations.find((row) => row.candidate_id === candidates[0].id)).toMatchObject({ challenge_average_score: null, challenge_comment: "Primary" });
      expect(pairEvaluations.find((row) => row.candidate_id === candidates[1].id)).toMatchObject({ challenge_average_score: null, challenge_comment: "Secondary via Admin" });
      let table = (await db.query<{ status: string }>(`select status::text from public.tables where id=$1`, [desks[0].id])).rows[0];
      table = (await db.query<{ status: string }>(`select status::text from public.tables where id=$1`, [desks[0].id])).rows[0];
      expect(table.status).toBe("AVAILABLE");
      rows = (await db.query<{ challenge_status: string; debate_batch_number: number | null; debate_request_status: string }>(`
        select challenge_status,debate_batch_number,debate_request_status from public.candidates
        where challenge_table_id=$1 order by code
      `, [desks[0].id])).rows;
      expect(rows.map((row) => row.challenge_status)).toEqual(["COMPLETED", "COMPLETED", "WAITING", "WAITING"]);
      await asUser(JUDGE, `select public.route_debate_request($1,$2)`, [candidates[2].id, desks[0].id]);
      const [routed] = (await db.query<{ challenge_table_id: string; debate_request_status: string }>(`
        select challenge_table_id,debate_request_status from public.candidates where id=$1
      `, [candidates[2].id])).rows;
      expect(routed).toMatchObject({ challenge_table_id: desks[1].id, debate_request_status: "PENDING" });
      await act(JUDGE2, candidates[2].id, desks[1].id, "REJECT");
      await act(JUDGE, candidates[2].id, desks[0].id, "ACCEPT");
      await act(JUDGE, candidates[3].id, desks[0].id, "ACCEPT");
      rows = (await db.query<{ challenge_status: string; debate_batch_number: number | null; debate_request_status: string }>(`
        select challenge_status,debate_batch_number,debate_request_status from public.candidates
        where challenge_table_id=$1 order by code
      `, [desks[0].id])).rows;
      expect(rows.slice(2).map((row) => row.challenge_status)).toEqual(["ASSIGNED", "ASSIGNED"]);
      await db.exec(`set request.jwt.claim.sub='${ADMIN}'; set role authenticated`);
      try {
        await db.query(`select public.admin_force_finish_debate_pair($1,'Overtime')`, [desks[0].id]);
      } finally {
        await db.exec("reset role");
      }
      table = (await db.query<{ status: string }>(`select status::text from public.tables where id=$1`, [desks[0].id])).rows[0];
      expect(table.status).toBe("AVAILABLE");
      rows = (await db.query<{ challenge_status: string; debate_batch_number: number | null; debate_request_status: string }>(`
        select challenge_status,debate_batch_number,debate_request_status from public.candidates
        where challenge_table_id=$1 order by code
      `, [desks[0].id])).rows;
      expect(rows.every((row) => row.challenge_status === "COMPLETED")).toBe(true);

      const [single, waiting] = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status,challenge_status,
          challenge_table_id,debate_request_status,challenge_started_at)
        values('DB-SINGLE','Single candidate','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now()),
              ('DB-LATER','Later candidate','HCTC','CHECKED_IN','WAITING',$1,'PENDING',now())
        returning id
      `, [desks[0].id])).rows;
      await db.query("insert into public.evaluations(candidate_id,comment) values($1,'Round one')", [single.id]);
      await act(JUDGE, single.id, desks[0].id, "ACCEPT");
      await expect(asUser(JUDGE3, `select public.start_debate_pair($1)`, [desks[0].id]))
        .rejects.toThrow(/Giám khảo Debate 1/);
      await asUser(JUDGE, `select public.start_debate_pair($1)`, [desks[0].id]);
      expect((await asUser(JUDGE3, `select comment from public.evaluations where candidate_id=$1`,
        [single.id])).rows).toMatchObject([{ comment: "Round one" }]);
      await expect(act(JUDGE, waiting.id, desks[0].id, "ACCEPT"))
        .rejects.toThrow(/đang diễn ra/);
      await expect(asUser(JUDGE3, `select public.confirm_debate_comment($1,$2,'Observer')`,
        [desks[0].id, single.id])).rejects.toThrow(/chỉ được xem phiếu/);
      await expect(asUser(ADMIN, `select public.admin_confirm_debate_comment($1,$2,$3,'Observer')`,
        [desks[0].id, single.id, JUDGE3])).rejects.toThrow(/chỉ được xem phiếu/);
      await asUser(JUDGE, `select public.confirm_debate_comment($1,$2,'Primary solo')`,
        [desks[0].id, single.id]);
      expect((await asUser(JUDGE3, `select comment from public.debate_judge_reviews where candidate_id=$1`,
        [single.id])).rows).toMatchObject([{ comment: "Primary solo" }]);
      await expect(asUser(JUDGE3, `select public.finalize_debate_pair($1,$2)`,
        [desks[0].id, null])).rejects.toThrow(/Giám khảo Debate 1/);
      await asUser(JUDGE, `select public.finalize_debate_pair($1,$2)`, [desks[0].id, null]);
      const oneCandidateResult = (await db.query<{ status: string; challenge_status: string; challenge_comment: string }>(`
        select c.status::text,c.challenge_status,e.challenge_comment
        from public.candidates c join public.evaluations e on e.candidate_id=c.id where c.id=$1
      `, [single.id])).rows[0];
      expect(oneCandidateResult).toEqual({ status: "COMPLETED", challenge_status: "COMPLETED", challenge_comment: "Primary solo" });
      expect((await db.query<{ status: string }>("select status::text from public.tables where id=$1", [desks[0].id])).rows[0].status)
        .toBe("AVAILABLE");
      expect((await db.query<{ challenge_status: string }>("select challenge_status from public.candidates where id=$1", [waiting.id])).rows[0].challenge_status)
        .toBe("WAITING");

      const [{ id: regularRoomId }] = (await db.query<{ id: string }>(`
        insert into public.rooms(name,building_code,room_number)
        values('DE-319','DE','319') returning id
      `)).rows;
      const [{ id: regularDeskId }] = (await db.query<{ id: string }>(`
        insert into public.tables(room_id,name,sort_order,department)
        values($1,'Bàn 1',1,'HCTC') returning id
      `, [regularRoomId])).rows;
      await db.query(`insert into auth.users(id,email) values($1,'interviewer@club.local')`, [INTERVIEWER]);
      await db.query(`insert into public.profiles(id,email,full_name,role,table_id)
        values($1,'interviewer@club.local','Interviewer','INTERVIEWER',$2)`, [INTERVIEWER, regularDeskId]);
      await db.query(`update public.rooms set is_configured=true where id=$1`, [regularRoomId]);
      const [{ id: nextCandidateId }] = (await db.query<{ id: string }>(`
        insert into public.candidates(code,full_name,department,status,table_id)
        values('DB7','Seventh','HCTC','INTERVIEWING',$1) returning id
      `, [regularDeskId])).rows;
      await db.query(`update public.tables set status='INTERVIEWING',current_candidate_id=$1,
        started_at=now() where id=$2`, [nextCandidateId, regularDeskId]);
      await asUser(INTERVIEWER, `select public.submit_evaluation_to_debate($1,$2::jsonb,'Round one',$3)`,
        [regularDeskId, JSON.stringify(scores), desks[0].id]);
      const next = (await db.query<{ challenge_status: string; debate_request_status: string; debate_batch_number: number | null }>(`
        select challenge_status,debate_request_status,debate_batch_number from public.candidates where id=$1
      `, [nextCandidateId])).rows[0];
      expect(next).toMatchObject({ challenge_status: "WAITING", debate_request_status: "PENDING", debate_batch_number: null });
      await asUser(INTERVIEWER, `insert into public.ops_messages(table_id,candidate_id,sender_id,kind,body)
        values($1,$2,$3,'CHAT','Xin trao đổi với giám khảo Debate')`, [regularDeskId, nextCandidateId, INTERVIEWER]);
      const judgeMessages = (await asUser(JUDGE, `select sender_label,body from public.ops_messages where candidate_id=$1`,
        [nextCandidateId])).rows as { sender_label: string; body: string }[];
      expect(judgeMessages).toMatchObject([{ sender_label: "Giám khảo phỏng vấn · Interviewer", body: "Xin trao đổi với giám khảo Debate" }]);
      expect((await asUser(JUDGE2, `select id from public.ops_messages where candidate_id=$1`,
        [nextCandidateId])).rows).toHaveLength(1);
      await asUser(JUDGE2, `insert into public.ops_messages(table_id,candidate_id,sender_id,kind,body)
        values($1,$2,$3,'CHAT','Bàn Debate bên cạnh đã nhận tin')`, [desks[1].id, nextCandidateId, JUDGE2]);
      expect((await asUser(INTERVIEWER, `select id from public.ops_messages where candidate_id=$1`,
        [nextCandidateId])).rows).toHaveLength(2);
      await act(JUDGE, nextCandidateId, desks[0].id, "ACCEPT");
      const accepted = (await db.query<{ debate_slot_number: number; debate_batch_number: number }>(`
        select debate_slot_number,debate_batch_number from public.candidates where id=$1
      `, [nextCandidateId])).rows[0];
      expect(accepted).toMatchObject({ debate_slot_number: 1, debate_batch_number: 4 });
    } finally {
      await db.close();
    }
  });
});
