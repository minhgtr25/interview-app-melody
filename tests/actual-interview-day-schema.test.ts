import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const schemaPath = new URL("../supabase/schema.sql", import.meta.url);
const migrationPath = new URL("../supabase/migrations/20261202_actual_interview_day.sql", import.meta.url);

describe.skipIf(!existsSync(schemaPath) || !existsSync(migrationPath))("actual interview day migration", () => {
  it("repairs an old early result and changes only that application", async () => {
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
    await db.exec(readFileSync(schemaPath, "utf8"));
    await db.exec("drop trigger evaluations_align_early_interview_day on public.evaluations");
    const [{ id: firstId }] = (await db.query<{ id: string }>(`
      insert into public.candidates (code,full_name,department,specialization,shift,status,interview_started_at)
      values ('EARLY-ROOT','Early interview','CM','HAT','10/11/2026 19:00 (CM)','COMPLETED','2026-11-09T12:00:00Z')
      returning id
    `)).rows;
    const [{ id: secondId }] = (await db.query<{ id: string }>(`
      insert into public.candidates (code,full_name,department,shift,status,source_candidate_id)
      values ('EARLY-CHILD','Early interview','VH','10/11/2026 20:00 (VH)','NOT_ARRIVED',$1)
      returning id
    `, [firstId])).rows;
    await db.query(`
      insert into public.evaluations (candidate_id,started_at,ended_at)
      values ($1,'2026-11-09T12:00:00Z','2026-11-09T12:30:00Z')
    `, [firstId]);
    await db.exec(readFileSync(migrationPath, "utf8"));

    const rows = (await db.query<{ id: string; shift: string; status: string; interview_note: string | null }>(`
      select id,shift,status::text,interview_note from public.candidates where id in ($1,$2)
    `, [firstId, secondId])).rows;
    expect(rows.find((row) => row.id === firstId)).toMatchObject({
      shift: "09/11/2026 19:00 (CM)", status: "COMPLETED",
    });
    expect(rows.find((row) => row.id === firstId)?.interview_note).toContain("10/11/2026");
    expect(rows.find((row) => row.id === secondId)).toMatchObject({
      shift: "10/11/2026 20:00 (VH)", status: "NOT_ARRIVED", interview_note: null,
    });

    const [{ id: thirdId }] = (await db.query<{ id: string }>(`
      insert into public.candidates (code,full_name,department,shift,status)
      values ('EARLY-NEXT','Another early interview','ND','11/11/2026 20:00 (ND)','INTERVIEWING')
      returning id
    `)).rows;
    await db.query(`
      insert into public.evaluations (candidate_id,started_at,ended_at)
      values ($1,'2026-11-10T12:00:00Z','2026-11-10T12:30:00Z')
    `, [thirdId]);
    const third = (await db.query<{ shift: string }>("select shift from public.candidates where id=$1", [thirdId])).rows[0];
    expect(third.shift).toBe("10/11/2026 20:00 (ND)");
    await db.close();
  });
});
