import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const ADMIN = "00000000-0000-0000-0000-0000000000f1";
const COORD = "00000000-0000-0000-0000-0000000000f2";
const JUDGE = "00000000-0000-0000-0000-0000000000f3";

describe("TV department visibility", () => {
  it("defaults to all departments, lets coordinators choose, and rejects unauthorized or invalid changes", async () => {
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
      const migration = readFileSync(new URL("../supabase/migrations/20261208_display_visible_departments.sql", import.meta.url), "utf8");
      await db.exec(migration);
      await db.exec(migration);
      await db.query("insert into auth.users(id,email) values($1,'admin@club.local'),($2,'coord@club.local'),($3,'judge@club.local')", [ADMIN, COORD, JUDGE]);
      await db.query(`insert into public.profiles(id,email,role)
        values($1,'admin@club.local','ADMIN'),($2,'coord@club.local','COORDINATOR'),($3,'judge@club.local','INTERVIEWER')`,
      [ADMIN, COORD, JUDGE]);
      const asUser = async <T>(id: string, sql: string, params: unknown[] = []) => {
        await db.exec(`set request.jwt.claim.sub='${id}'; set role authenticated`);
        try { return (await db.query<T>(sql, params)).rows; }
        finally { await db.exec("reset role"); }
      };
      const all = ["CM", "VH", "TT", "ND", "HCTC"];
      expect((await asUser<{ visible_departments: string[] }>(COORD,
        "select visible_departments from public.display_settings where id='main'"))[0].visible_departments).toEqual(all);
      await asUser(COORD, "update public.display_settings set visible_departments=array['VH','HCTC']::text[] where id='main'");
      expect((await asUser<{ visible_departments: string[] }>(ADMIN,
        "select visible_departments from public.display_settings where id='main'"))[0].visible_departments).toEqual(["VH", "HCTC"]);
      expect(await asUser(JUDGE,
        "update public.display_settings set visible_departments=array['CM']::text[] where id='main' returning id"))
        .toHaveLength(0);
      await expect(asUser(COORD,
        "update public.display_settings set visible_departments=array['INVALID']::text[] where id='main'"))
        .rejects.toThrow();
      await asUser(COORD, "update public.display_settings set visible_departments=array[]::text[] where id='main'");
      expect((await asUser<{ visible_departments: string[] }>(ADMIN,
        "select visible_departments from public.display_settings where id='main'"))[0].visible_departments).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
