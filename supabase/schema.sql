-- =====================================================================
--  CLB Casting / Interview Management - Supabase schema
--  Chạy toàn bộ file này trong Supabase Dashboard > SQL Editor.
--  Dành cho project Supabase mới; chạy sau khi tạo project, trước seed:admin.
--  File này tạo đầy đủ bảng, RPC, RLS, Realtime, chat, bảng gọi tên TV
--  và tiêu chí chấm mặc định.
--  Không chạy thêm các file trong supabase/migrations trên project mới.
-- =====================================================================

-- gen_random_uuid() có sẵn từ PostgreSQL 13 (Supabase dùng PG 15+), không cần extension.

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('ADMIN', 'SUPPORT_IT', 'CHECKIN', 'COORDINATOR', 'INTERVIEWER');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Vòng đời: NOT_ARRIVED -> CHECKED_IN -> ASSIGNED -> INTERVIEWING -> COMPLETED (hoặc ABSENT)
  create type public.candidate_status as enum
    ('NOT_ARRIVED', 'CHECKED_IN', 'ASSIGNED', 'INTERVIEWING', 'COMPLETED', 'ABSENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.table_status as enum ('AVAILABLE', 'ASSIGNED', 'INTERVIEWING');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  building_code text check (building_code in ('BE', 'DE', 'EP', 'AL')),
  room_number text check (room_number ~ '^[1-4](0[1-9]|[1-3][0-9]|40)$'),
  is_configured boolean not null default false,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists rooms_active_building_number_unique on public.rooms(building_code, room_number)
  where is_configured;

create table if not exists public.tables (
  id                   uuid primary key default gen_random_uuid(),
  room_id              uuid not null references public.rooms(id) on delete cascade,
  name                 text not null,
  sort_order           int  not null default 0,
  department           text check (department in ('CM', 'VH', 'TT', 'ND', 'HCTC')),
  status               public.table_status not null default 'AVAILABLE',
  current_candidate_id uuid,
  assigned_at          timestamptz,
  started_at           timestamptz,
  last_alarm_at        timestamptz,
  is_paused            boolean not null default false,
  created_at           timestamptz not null default now()
);

-- Room code is derived from the selected building and room number.
create or replace function public.room_name_from_selection() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.building_code is not null and new.room_number is not null then
    new.name := new.building_code || '-' || new.room_number;
  end if;
  return new;
end $$;
drop trigger if exists rooms_name_from_selection on public.rooms;
create trigger rooms_name_from_selection before insert or update of building_code, room_number on public.rooms
for each row execute function public.room_name_from_selection();

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        public.user_role not null,
  table_id    uuid references public.tables(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Mỗi bàn có tối đa một tài khoản đăng nhập đại diện, dù có nhiều giám khảo thực tế.
create unique index if not exists profiles_one_interviewer_per_table
  on public.profiles(table_id) where role = 'INTERVIEWER' and table_id is not null;

create or replace function public.validate_room_activation() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_configured then
    if new.building_code is null or new.room_number is null then
      raise exception 'Chọn Tòa và Số phòng trước khi kích hoạt';
    end if;
    if (select count(*) from public.tables where room_id = new.id) not between 1 and 4 then
      raise exception 'Phòng phải có từ 1 đến 4 bàn';
    end if;
    if exists (select 1 from public.tables t where t.room_id = new.id and
      (t.department is null or not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER'))) then
      raise exception 'Mỗi bàn cần Ban và một tài khoản đại diện trước khi kích hoạt';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_activation on public.rooms;
create trigger rooms_validate_activation before insert or update of is_configured on public.rooms
for each row execute function public.validate_room_activation();

create table if not exists public.candidates (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  full_name             text not null,
  student_number        text check (student_number ~ '^[A-Z0-9]{8}$'),
  student_number_raw    text,
  student_cohort        text check (length(student_cohort) <= 32),
  gender                text check (gender in ('NAM', 'NU', 'KHAC')),
  facebook_url          text check (length(facebook_url) <= 2000),
  phone                 text,
  email                 text,
  department            text,
  shift                 text,
  source_candidate_id   uuid references public.candidates(id) on delete cascade,
  cv_url                text,
  status                public.candidate_status not null default 'NOT_ARRIVED',
  checked_in_at         timestamptz,
  table_id              uuid references public.tables(id) on delete set null,
  assigned_at           timestamptz,
  interview_started_at  timestamptz,
  interview_ended_at    timestamptz,
  duration_seconds      int,
  absent_at             timestamptz,
  absent_note           text check (length(absent_note) <= 2000),
  added_by_id           uuid references auth.users(id) on delete set null,
  added_by_name         text,
  added_by_email        text,
  added_by_role         public.user_role,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists candidates_source_candidate_idx on public.candidates(source_candidate_id)
  where source_candidate_id is not null;
create unique index if not exists candidates_root_student_number_key
  on public.candidates(student_number) where source_candidate_id is null;

do $$ begin
  alter table public.tables
    add constraint tables_current_candidate_fk
    foreign key (current_candidate_id) references public.candidates(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.rubric_criteria (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  max_score   int not null default 10 check (max_score between 1 and 100),
  weight      numeric(6,2) not null default 1 check (weight > 0),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.evaluations (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid not null unique references public.candidates(id) on delete cascade,
  table_id         uuid references public.tables(id) on delete set null,
  interviewer_id   uuid references public.profiles(id) on delete set null,
  interviewer_name text,            -- snapshot để export không mất tên khi xoá tài khoản
  table_label      text,            -- snapshot "Phòng - Bàn"
  scores           jsonb not null default '{}'::jsonb,  -- { "<criterion_id>": score }
  average_score    numeric(5,2),    -- trung bình có trọng số, quy về thang 10
  comment          text,
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_seconds int,
  created_at       timestamptz not null default now()
);
create index if not exists evaluations_table_ended_idx on public.evaluations(table_id, ended_at desc);

-- Department review portals are accessed only through server-side service-role
-- actions after an Admin opens them and a reviewer enters the 4-character code.
create table if not exists public.review_portals (
  department text primary key check (department in ('CM', 'VH', 'TT', 'ND', 'HCTC')),
  active boolean not null default false,
  code_hash text not null,
  generation uuid not null default gen_random_uuid(),
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.review_decisions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.candidates(id) on delete cascade,
  department text not null check (department in ('CM', 'VH', 'TT', 'ND', 'HCTC')),
  decision text not null check (decision in ('PASS', 'FAIL', 'CONSIDER')),
  note text not null default '' check (length(note) <= 2000),
  portal_generation uuid not null,
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists review_decisions_department_idx on public.review_decisions(department, decision);

create table if not exists public.review_decision_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  department text not null,
  decision text not null,
  note text not null,
  portal_generation uuid not null,
  changed_at timestamptz not null default now()
);
create index if not exists review_decision_events_candidate_time_idx on public.review_decision_events(candidate_id, changed_at desc);
create index if not exists review_decision_events_time_idx on public.review_decision_events(changed_at desc);

create or replace function public.validate_review_decision() returns trigger
language plpgsql set search_path = public as $$
declare
  v_department text;
  v_status public.candidate_status;
begin
  select department, status into v_department, v_status from public.candidates where id = new.candidate_id;
  if v_department is distinct from new.department or v_status <> 'COMPLETED' then
    raise exception 'Chỉ chốt kết quả cho thí sinh đã hoàn thành đúng Ban';
  end if;
  if not exists (select 1 from public.review_portals
    where department = new.department and active and generation = new.portal_generation) then
    raise exception 'Cổng chấm của Ban đã đóng hoặc mã đã thay đổi';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists review_decisions_validate on public.review_decisions;
create trigger review_decisions_validate before insert or update on public.review_decisions
for each row execute function public.validate_review_decision();

create or replace function public.record_review_decision() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.review_decision_events (candidate_id, department, decision, note, portal_generation)
    values (new.candidate_id, new.department, new.decision, new.note, new.portal_generation);
  elsif new.decision is distinct from old.decision or new.note is distinct from old.note then
    insert into public.review_decision_events (candidate_id, department, decision, note, portal_generation)
    values (new.candidate_id, new.department, new.decision, new.note, new.portal_generation);
  end if;
  return new;
end $$;
drop trigger if exists review_decisions_record on public.review_decisions;
create trigger review_decisions_record after insert or update on public.review_decisions
for each row execute function public.record_review_decision();

create or replace function public.clear_review_decision_on_reset() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'COMPLETED' and new.status <> 'COMPLETED' then
    delete from public.review_decisions where candidate_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists candidates_clear_review_decision on public.candidates;
create trigger candidates_clear_review_decision after update of status on public.candidates
for each row execute function public.clear_review_decision_on_reset();

create or replace function public.verify_review_portal(p_department text, p_code_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v public.review_portals;
begin
  select * into v from public.review_portals where department = p_department for update;
  if not found or not v.active or (v.locked_until is not null and v.locked_until > clock_timestamp()) then
    return null;
  end if;
  if v.code_hash = p_code_hash then
    update public.review_portals set failed_attempts = 0, locked_until = null where department = p_department;
    return v.generation;
  end if;
  update public.review_portals
     set failed_attempts = case when v.failed_attempts >= 9 then 0 else v.failed_attempts + 1 end,
         locked_until = case when v.failed_attempts >= 9 then clock_timestamp() + interval '5 minutes' else null end
   where department = p_department;
  return null;
end $$;

create table if not exists public.ops_messages (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null references public.tables(id) on delete cascade,
  candidate_id uuid references public.candidates(id) on delete cascade,
  sender_id   uuid references auth.users(id) on delete set null,
  sender_label text,
  kind        text not null check (kind in ('CHAT', 'ALARM')),
  body        text not null check (length(trim(body)) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists ops_messages_table_time_idx on public.ops_messages(table_id, created_at);
create index if not exists ops_messages_candidate_time_idx on public.ops_messages(candidate_id, created_at) where candidate_id is not null;

-- Needed by the candidate-scoped ops_messages policies below; repeated safely
-- in the challenge section to keep migrations and fresh installs in sync.
alter table public.candidates add column if not exists challenge_table_id uuid references public.tables(id) on delete set null;

-- Bảng gọi thí sinh trên TV: chỉ giữ người đã gán, chưa bắt đầu phỏng vấn.
create table if not exists public.display_calls (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.candidates(id) on delete cascade,
  table_id     uuid references public.tables(id) on delete set null,
  department   text not null check (department in ('CM', 'VH', 'TT', 'ND', 'HCTC')),
  display_name text not null,
  display_code text not null,
  room_label   text not null,
  called_at    timestamptz not null default now()
);
create index if not exists display_calls_department_time_idx
  on public.display_calls(department, called_at desc);

create table if not exists public.display_settings (
  id            text primary key default 'main' check (id = 'main'),
  identity_mode text not null default 'NAME' check (identity_mode in ('NAME', 'CODE'))
);
insert into public.display_settings (id) values ('main') on conflict (id) do nothing;

create index if not exists candidates_status_idx  on public.candidates(status);
create index if not exists candidates_checkin_idx on public.candidates(checked_in_at);
create index if not exists tables_room_idx        on public.tables(room_id);
create index if not exists profiles_table_idx     on public.profiles(table_id);

-- updated_at trigger
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists candidates_touch on public.candidates;
create trigger candidates_touch before update on public.candidates
  for each row execute function public.touch_updated_at();

create or replace function public.clear_absent_note_when_resolved() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status <> 'ABSENT' then
    new.absent_note := null;
  end if;
  return new;
end $$;
drop trigger if exists candidates_clear_absent_note on public.candidates;
create trigger candidates_clear_absent_note before update of status on public.candidates
  for each row execute function public.clear_absent_note_when_resolved();

-- ---------------------------------------------------------------------
-- ROLE HELPERS (security definer để tránh đệ quy RLS trên profiles)
-- ---------------------------------------------------------------------
create or replace function public.current_user_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'ADMIN')
$$;

create or replace function public._require_role(p_roles public.user_role[]) returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid();
  if v.id is null or not (v.role = any (p_roles)) then
    raise exception 'Bạn không có quyền thực hiện thao tác này' using errcode = '42501';
  end if;
  return v;
end $$;

-- Helper: sinh mã ứng viên dạng số ngắn tuần tự (001, 002, ...; tự mở rộng 4+ số)
create or replace function public._next_candidate_code() returns text
language sql security definer set search_path = public as $$
  select 'UV-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
$$;

create or replace function public.import_form_candidates(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_raw_number text;
  v_number text;
  v_email text;
  v_department text;
  v_existing public.candidates;
  v_application public.candidates;
  v_count integer := 0;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'File phải có từ 1 đến 5000 thí sinh';
  end if;
  for v_row in select * from jsonb_to_recordset(p_rows) as x(
    student_number text, full_name text, student_cohort text, gender text,
    phone text, email text, facebook_url text, department text
  ) loop
    v_raw_number := upper(btrim(coalesce(v_row.student_number, '')));
    v_number := case when v_raw_number ~ '^[A-Z0-9]{8}$' then v_raw_number else null end;
    v_email := lower(nullif(btrim(coalesce(v_row.email, '')), ''));
    v_department := upper(btrim(coalesce(v_row.department, '')));

    if v_number is null and v_email is null then
      raise exception 'MSSV chưa hợp lệ và không có Email để nhận diện';
    end if;
    if length(btrim(coalesce(v_row.full_name, ''))) not between 1 and 200 then raise exception 'Họ tên không hợp lệ'; end if;
    if v_row.gender is null or v_row.gender not in ('NAM', 'NU', 'KHAC') then raise exception 'Giới tính không hợp lệ'; end if;
    if v_department not in ('CM', 'VH', 'TT', 'ND', 'HCTC') then raise exception 'Ban không hợp lệ'; end if;
    if length(btrim(coalesce(v_row.student_cohort, ''))) > 32 then raise exception 'Khóa sinh viên quá dài'; end if;
    if length(btrim(coalesce(v_row.phone, ''))) > 32 then raise exception 'Số điện thoại quá dài'; end if;
    if length(coalesce(v_email, '')) > 200 then raise exception 'Email quá dài'; end if;
    if length(btrim(coalesce(v_row.facebook_url, ''))) > 2000 then raise exception 'Link Facebook quá dài'; end if;

    if v_number is not null then
      select * into v_existing from public.candidates
      where student_number = v_number and source_candidate_id is null
      for update;
    else
      select * into v_existing from public.candidates
      where lower(email) = v_email and source_candidate_id is null
      for update;
    end if;

    if found then
      if v_existing.department = v_department then
        v_application := v_existing;
      else
        select * into v_application from public.candidates
        where source_candidate_id = v_existing.id and department = v_department
        for update;
        if not found then
          insert into public.candidates (
            code, full_name, student_cohort, gender, phone, email, facebook_url,
            department, source_candidate_id, status
          ) values (
            public._next_candidate_code(), btrim(v_row.full_name), nullif(btrim(v_row.student_cohort), ''),
            v_row.gender, nullif(btrim(v_row.phone), ''), v_email, nullif(btrim(v_row.facebook_url), ''),
            v_department, v_existing.id, 'NOT_ARRIVED'
          ) returning * into v_application;
        end if;
      end if;
      update public.candidates set
        full_name = btrim(v_row.full_name),
        student_cohort = nullif(btrim(v_row.student_cohort), ''),
        gender = v_row.gender,
        phone = nullif(btrim(v_row.phone), ''),
        email = v_email,
        facebook_url = nullif(btrim(v_row.facebook_url), '')
      where id = v_application.id;
    else
      insert into public.candidates (
        code, student_number, student_number_raw, full_name, student_cohort, gender,
        phone, email, facebook_url, department, status
      ) values (
        public._next_candidate_code(), v_number, case when v_number is null then v_raw_number else null end,
        btrim(v_row.full_name), nullif(btrim(v_row.student_cohort), ''), v_row.gender,
        nullif(btrim(v_row.phone), ''), v_email, nullif(btrim(v_row.facebook_url), ''),
        v_department, 'NOT_ARRIVED'
      );
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Import lịch của nhiều ngày vào Ca; mọi dòng phải đối chiếu được trước khi ghi.
create or replace function public.import_candidate_schedules(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_number text;
  v_email text;
  v_department text;
  v_id uuid;
  v_matches int;
  v_map jsonb := '{}'::jsonb;
  v_entry record;
  v_shift text;
  v_count int := 0;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Lịch phải có từ 1 đến 5000 dòng';
  end if;
  for v_row in select * from jsonb_to_recordset(p_rows) as x(student_number text, email text, shift text) loop
    v_count := v_count + 1;
    v_number := upper(btrim(coalesce(v_row.student_number, '')));
    v_email := lower(btrim(coalesce(v_row.email, '')));
    v_shift := btrim(coalesce(v_row.shift, ''));
    v_department := upper((regexp_match(v_shift, '\(([A-Z]+)\)\s*$'))[1]);
    if length(v_shift) not between 1 and 120 then raise exception 'Ca không hợp lệ ở dòng %', v_count; end if;

    if v_number ~ '^[A-Z0-9]{8}$' then
      select count(*), min(id::text)::uuid into v_matches, v_id
      from public.candidates
      where student_number = v_number
        and (v_department is null or department = v_department);
    else
      v_matches := 0;
    end if;
    if v_matches = 0 and v_email <> '' then
      select count(*), min(id::text)::uuid into v_matches, v_id
      from public.candidates
      where lower(email) = v_email
        and (v_department is null or department = v_department);
    end if;
    -- Hỗ trợ dữ liệu lịch cũ chưa có bản ghi theo từng Ban.
    if v_matches = 0 then
      if v_number ~ '^[A-Z0-9]{8}$' then
        select count(*), min(id::text)::uuid into v_matches, v_id
        from public.candidates
        where student_number = v_number and source_candidate_id is null;
      elsif v_email <> '' then
        select count(*), min(id::text)::uuid into v_matches, v_id
        from public.candidates
        where lower(email) = v_email and source_candidate_id is null;
      end if;
    end if;
    if v_matches <> 1 then
      raise exception 'Không đối chiếu được thí sinh ở dòng lịch %', v_count;
    end if;
    v_map := jsonb_set(v_map, array[v_id::text],
      coalesce(v_map -> v_id::text, '[]'::jsonb) || to_jsonb(v_shift), true);
  end loop;
  for v_entry in select * from jsonb_each(v_map) loop
    select string_agg(value, ' · ' order by ord) into v_shift
      from jsonb_array_elements_text(v_entry.value) with ordinality as x(value, ord);
    update public.candidates set shift = v_shift where id = v_entry.key::uuid;
  end loop;
  return v_count;
end $$;

create or replace function public.send_table_alarm(p_table_id uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  v_at timestamptz := clock_timestamp();
begin
  v := public._require_role(array['INTERVIEWER']::public.user_role[]);
  if v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'AVAILABLE' then raise exception 'Bàn chưa sẵn sàng nhận thí sinh'; end if;
  if not exists (select 1 from public.rooms where id = t.room_id and is_configured) then
    raise exception 'Phòng chưa được kích hoạt';
  end if;
  if t.last_alarm_at is not null and v_at < t.last_alarm_at + interval '30 seconds' then
    raise exception 'Vui lòng đợi 30 giây giữa các alarm';
  end if;
  update public.tables set last_alarm_at = v_at where id = t.id;
  insert into public.ops_messages (table_id, sender_id, kind, body)
    values (t.id, v.id, 'ALARM', 'Đã hoàn thành ca chấm, sẵn sàng nhận thí sinh tiếp theo');
  return v_at;
end $$;

-- ---------------------------------------------------------------------
-- WORKFLOW RPCs
-- Mọi chuyển trạng thái đi qua các hàm dưới đây (khoá hàng FOR UPDATE)
-- để tránh 2 người thao tác cùng lúc gây lệch dữ liệu.
-- Thứ tự khoá luôn là: tables -> candidates (tránh deadlock).
-- ---------------------------------------------------------------------

-- Bổ sung thí sinh tại bàn Check-in: tạo và điểm danh trong cùng giao dịch.
-- Nguồn thêm lấy từ phiên đăng nhập, không nhận từ dữ liệu client.
create or replace function public.add_walk_in_candidate(
  p_code text, p_full_name text, p_department text,
  p_phone text default null, p_email text default null, p_shift text default null,
  p_student_number text default null, p_student_cohort text default null,
  p_gender text default null, p_facebook_url text default null
) returns public.candidates
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  v_candidate public.candidates;
  v_code text := btrim(coalesce(p_code, ''));
  v_name text := btrim(coalesce(p_full_name, ''));
  v_department text := upper(btrim(coalesce(p_department, '')));
  v_number text := upper(btrim(coalesce(p_student_number, '')));
  v_gender text := upper(btrim(coalesce(p_gender, '')));
begin
  v := public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  if v_code = '' or length(v_code) > 64 then raise exception 'Mã ứng viên phải có từ 1 đến 64 ký tự'; end if;
  if v_name = '' or length(v_name) > 200 then raise exception 'Họ tên phải có từ 1 đến 200 ký tự'; end if;
  if v_department not in ('CM', 'VH', 'TT', 'ND', 'HCTC') then raise exception 'Chọn Ban ứng tuyển hợp lệ'; end if;
  if v_number !~ '^[A-Z0-9]{8}$' then raise exception 'MSSV phải gồm đúng 8 chữ hoặc số'; end if;
  if v_gender not in ('NAM', 'NU', 'KHAC') then raise exception 'Chọn Giới tính hợp lệ'; end if;
  if length(btrim(coalesce(p_student_cohort, ''))) > 32 then raise exception 'Khóa sinh viên quá dài'; end if;
  if length(btrim(coalesce(p_facebook_url, ''))) > 2000 then raise exception 'Link Facebook quá dài'; end if;
  if length(btrim(coalesce(p_phone, ''))) > 32 then raise exception 'Số điện thoại quá dài'; end if;
  if length(btrim(coalesce(p_email, ''))) > 200 then raise exception 'Email quá dài'; end if;
  if length(btrim(coalesce(p_shift, ''))) > 120 then raise exception 'Ca phỏng vấn quá dài'; end if;

  insert into public.candidates
    (code, full_name, student_number, student_cohort, gender, facebook_url,
     phone, email, department, shift, status, checked_in_at,
     added_by_id, added_by_name, added_by_email, added_by_role)
  values
    (v_code, v_name, v_number, nullif(btrim(p_student_cohort), ''), v_gender, nullif(btrim(p_facebook_url), ''),
     nullif(btrim(p_phone), ''), lower(nullif(btrim(p_email), '')),
     v_department, nullif(btrim(p_shift), ''), 'CHECKED_IN', now(),
     v.id, coalesce(nullif(v.full_name, ''), v.email), v.email, v.role)
  returning * into v_candidate;
  return v_candidate;
end $$;

-- Check-in: NOT_ARRIVED/ABSENT -> CHECKED_IN
create or replace function public.check_in_candidate(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status public.candidate_status;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);

  select status into v_status from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_status not in ('NOT_ARRIVED', 'ABSENT') then
    raise exception 'Thí sinh đã được check-in trước đó';
  end if;

  update public.candidates
     set status = 'CHECKED_IN', checked_in_at = now(), absent_at = null
   where id = p_candidate_id;
end $$;

-- Hoàn tác check-in (bấm nhầm): CHECKED_IN -> NOT_ARRIVED
create or replace function public.undo_check_in(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status public.candidate_status;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);

  select status into v_status from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_status <> 'CHECKED_IN' then
    raise exception 'Chỉ hoàn tác được khi thí sinh đang ở hàng chờ';
  end if;

  update public.candidates
     set status = 'NOT_ARRIVED', checked_in_at = null
   where id = p_candidate_id;
end $$;

-- Vắng mặt / bỏ lượt: NOT_ARRIVED/CHECKED_IN -> ABSENT
create or replace function public.mark_absent(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status public.candidate_status;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);

  select status into v_status from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_status not in ('NOT_ARRIVED', 'CHECKED_IN') then
    raise exception 'Không thể đánh vắng thí sinh đang ở bàn hoặc đã hoàn thành';
  end if;

  update public.candidates
     set status = 'ABSENT', absent_at = now()
   where id = p_candidate_id;
end $$;

create or replace function public.mark_absent_with_note(p_candidate_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status public.candidate_status;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);

  select status into v_status from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_status not in ('NOT_ARRIVED', 'CHECKED_IN') then
    raise exception 'Không thể đánh vắng thí sinh đang ở bàn hoặc đã hoàn thành';
  end if;

  update public.candidates
     set status = 'ABSENT', absent_at = now(), absent_note = left(nullif(trim(p_note), ''), 2000)
   where id = p_candidate_id;
end $$;

-- Check-in staff may add or revise notes for candidates already marked absent.
create or replace function public.update_absent_note(p_candidate_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status public.candidate_status;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  select status into v_status from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_status <> 'ABSENT' then raise exception 'Chỉ sửa ghi chú của thí sinh đang vắng mặt'; end if;

  update public.candidates
     set absent_note = left(nullif(trim(p_note), ''), 2000)
   where id = p_candidate_id;
end $$;

-- Điều phối gán thí sinh vào bàn: CHECKED_IN -> ASSIGNED
create or replace function public.assign_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  v_configured boolean;
  c public.candidates;
begin
  perform public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);

  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'AVAILABLE' then raise exception 'Bàn này đang bận'; end if;

  select * into c from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.status <> 'CHECKED_IN' then raise exception 'Thí sinh không còn ở hàng chờ'; end if;
  select is_configured into v_configured from public.rooms where id = t.room_id;
  if not coalesce(v_configured, false) then raise exception 'Phòng chưa được kích hoạt'; end if;
  if t.department is null then raise exception 'Bàn chưa được cấu hình Ban'; end if;
  if c.department is distinct from t.department then raise exception 'Ban của thí sinh không khớp Ban phụ trách bàn'; end if;
  if not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER') then
    raise exception 'Bàn chưa có tài khoản đại diện';
  end if;

  update public.tables
     set status = 'ASSIGNED', current_candidate_id = c.id, assigned_at = now(), started_at = null
   where id = t.id;

  update public.candidates
     set status = 'ASSIGNED', table_id = t.id, assigned_at = now()
   where id = c.id;

  -- Serialize calls for the same department so pruning cannot race.
  perform pg_advisory_xact_lock(hashtext('display_calls:' || t.department));
  delete from public.display_calls where candidate_id = c.id;
  insert into public.display_calls (candidate_id, table_id, department, display_name, display_code, room_label)
    select c.id, t.id, t.department, c.full_name, c.code, r.name
    from public.rooms r where r.id = t.room_id;
  delete from public.display_calls d
    where d.department = t.department and d.id not in (
      select id from public.display_calls where department = t.department
      order by called_at desc, id desc limit 5
    );
end $$;

-- Giám khảo xác nhận thí sinh đã vào bàn: ASSIGNED -> INTERVIEWING
create or replace function public.start_interview(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;

  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'ASSIGNED' or t.current_candidate_id is null then
    raise exception 'Không có thí sinh nào đang chờ xác nhận ở bàn này';
  end if;

  delete from public.display_calls where candidate_id = t.current_candidate_id;

  update public.tables set status = 'INTERVIEWING', started_at = now() where id = t.id;

  update public.candidates
     set status = 'INTERVIEWING', interview_started_at = now()
   where id = t.current_candidate_id;
end $$;

-- Trả thí sinh về phòng chờ (nhầm người / thí sinh không vào): ASSIGNED|INTERVIEWING -> CHECKED_IN
-- Giữ nguyên checked_in_at để thí sinh không bị mất lượt trong hàng chờ.
create or replace function public.return_to_queue(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
begin
  v := public._require_role(array['ADMIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;

  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;

  if t.current_candidate_id is not null then
    delete from public.display_calls where candidate_id = t.current_candidate_id;
    update public.candidates
       set status = 'CHECKED_IN', table_id = null, assigned_at = null, interview_started_at = null
     where id = t.current_candidate_id
       and status in ('ASSIGNED', 'INTERVIEWING');
  end if;

  update public.tables
     set status = 'AVAILABLE', current_candidate_id = null, assigned_at = null, started_at = null
   where id = t.id;
end $$;

-- Nộp đánh giá & kết thúc: INTERVIEWING -> COMPLETED, giải phóng bàn.
-- Thời lượng được tính trên server (không phụ thuộc đồng hồ thiết bị).
create or replace function public.submit_evaluation(p_table_id uuid, p_scores jsonb, p_comment text)
returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  v        public.profiles;
  t        public.tables;
  r        record;
  v_score  numeric;
  v_sum    numeric := 0;
  v_wsum   numeric := 0;
  v_clean  jsonb := '{}'::jsonb;
  v_avg    numeric;
  v_dur    int;
  v_room   text;
  v_eval   public.evaluations;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;

  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'INTERVIEWING' or t.current_candidate_id is null then
    raise exception 'Bàn này không có buổi phỏng vấn đang diễn ra';
  end if;

  perform 1 from public.candidates where id = t.current_candidate_id for update;

  if p_scores is null or jsonb_typeof(p_scores) <> 'object' then
    raise exception 'Dữ liệu điểm không hợp lệ';
  end if;

  for r in select * from public.rubric_criteria where active order by sort_order, created_at loop
    if not (p_scores ? r.id::text) then
      raise exception 'Chưa chấm tiêu chí "%"', r.name;
    end if;
    begin
      v_score := (p_scores ->> r.id::text)::numeric;
    exception when others then
      raise exception 'Điểm không hợp lệ ở tiêu chí "%"', r.name;
    end;
    if v_score is null or v_score < 0 or v_score > r.max_score then
      raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %', r.name, r.max_score;
    end if;
    v_clean := v_clean || jsonb_build_object(r.id::text, v_score);
    v_sum   := v_sum + (v_score / r.max_score) * 10 * r.weight;
    v_wsum  := v_wsum + r.weight;
  end loop;

  v_avg := case when v_wsum > 0 then round(v_sum / v_wsum, 2) end;
  v_dur := greatest(0, floor(extract(epoch from (now() - coalesce(t.started_at, now())))))::int;
  select name into v_room from public.rooms where id = t.room_id;

  insert into public.evaluations as e
    (candidate_id, table_id, interviewer_id, interviewer_name, table_label,
     scores, average_score, comment, started_at, ended_at, duration_seconds)
  values
    (t.current_candidate_id, t.id, v.id, coalesce(nullif(v.full_name, ''), v.email),
     coalesce(v_room, '') || ' - ' || t.name,
     v_clean, v_avg, left(nullif(trim(p_comment), ''), 5000), t.started_at, now(), v_dur)
  on conflict (candidate_id) do update set
     table_id = excluded.table_id, interviewer_id = excluded.interviewer_id,
     interviewer_name = excluded.interviewer_name, table_label = excluded.table_label,
     scores = excluded.scores, average_score = excluded.average_score, comment = excluded.comment,
     started_at = excluded.started_at, ended_at = excluded.ended_at,
     duration_seconds = excluded.duration_seconds, created_at = now()
  returning * into v_eval;

  update public.candidates
     set status = 'COMPLETED', interview_ended_at = now(), duration_seconds = v_dur
   where id = t.current_candidate_id;

  update public.tables
     set status = 'AVAILABLE', current_candidate_id = null, assigned_at = null, started_at = null
   where id = t.id;

  return v_eval;
end $$;

-- Chuyên Môn có thể gửi nguyện vọng phỏng vấn Ban thứ hai ngay sau khi chấm.
-- Hồ sơ thứ hai liên kết với hồ sơ CM để hai lượt có điểm và kết quả độc lập.
create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text, p_second_department text default null
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  v_eval public.evaluations;
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is not null then
    if p_second_department not in ('VH', 'TT', 'ND', 'HCTC') then
      raise exception 'Ban thứ hai không hợp lệ';
    end if;
    select * into t from public.tables where id = p_table_id for update;
    if t.department is distinct from 'CM' or t.current_candidate_id is null then
      raise exception 'Chỉ bàn Chuyên Môn được chọn Ban thứ hai';
    end if;
    select * into c from public.candidates where id = t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then
      raise exception 'Chỉ thí sinh Chuyên Môn gốc được phỏng vấn Ban thứ hai';
    end if;
    if exists (select 1 from public.candidates where source_candidate_id = c.id) then
      raise exception 'Thí sinh đã có lượt phỏng vấn Ban thứ hai';
    end if;
  end if;

  v_eval := public.submit_evaluation(p_table_id, p_scores, p_comment);
  if p_second_department is not null then
    insert into public.candidates (
      code, full_name, student_cohort, gender, facebook_url, phone, email,
      department, shift, cv_url, source_candidate_id, status, checked_in_at
    ) values (
      public._next_candidate_code(),
      c.full_name, c.student_cohort, c.gender, c.facebook_url, c.phone, c.email,
      p_second_department, c.shift, c.cv_url, c.id, 'CHECKED_IN', now()
    );
  end if;
  return v_eval;
end $$;

-- Admin: đưa thí sinh về "Chưa đến" (xoá đánh giá, giải phóng bàn nếu đang ngồi)
create or replace function public.admin_reset_candidate(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);

  delete from public.display_calls where candidate_id = p_candidate_id;

  update public.tables
     set status = 'AVAILABLE', current_candidate_id = null, assigned_at = null, started_at = null
   where current_candidate_id = p_candidate_id;

  delete from public.evaluations where candidate_id = p_candidate_id;

  update public.candidates
     set status = 'NOT_ARRIVED', checked_in_at = null, table_id = null, assigned_at = null,
         interview_started_at = null, interview_ended_at = null, duration_seconds = null,
         absent_at = null
   where id = p_candidate_id;
end $$;

-- Quyền gọi hàm: chỉ người đã đăng nhập (vai trò được kiểm tra bên trong hàm)
revoke execute on function public._require_role(public.user_role[]) from public, anon;
revoke execute on function public._next_candidate_code()              from public, anon;
revoke execute on function public.import_form_candidates(jsonb)       from public, anon;
revoke execute on function public.import_candidate_schedules(jsonb)    from public, anon;
revoke execute on function public.add_walk_in_candidate(text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke execute on function public.check_in_candidate(uuid)            from public, anon;
revoke execute on function public.undo_check_in(uuid)                 from public, anon;
revoke execute on function public.mark_absent(uuid)                   from public, anon;
revoke execute on function public.mark_absent_with_note(uuid, text)    from public, anon;
revoke execute on function public.update_absent_note(uuid, text)        from public, anon;
revoke execute on function public.assign_candidate(uuid, uuid)        from public, anon;
revoke execute on function public.start_interview(uuid)               from public, anon;
revoke execute on function public.return_to_queue(uuid)               from public, anon;
revoke execute on function public.submit_evaluation(uuid, jsonb, text) from public, anon;
revoke execute on function public.submit_evaluation_with_referral(uuid, jsonb, text, text) from public, anon;
revoke execute on function public.admin_reset_candidate(uuid)         from public, anon;
revoke execute on function public.send_table_alarm(uuid)              from public, anon;

-- Kích hoạt lượt phỏng vấn tiếp theo khi lượt trước đã hoàn thành và lịch đã đến.
create or replace function public.activate_due_followups() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_count integer;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  update public.candidates child set
    status = 'CHECKED_IN', checked_in_at = coalesce(child.checked_in_at, now()), absent_at = null
  where child.source_candidate_id is not null
    and child.status = 'NOT_ARRIVED'
    and exists (
      select 1 from public.candidates parent
      where parent.id = child.source_candidate_id and parent.status = 'COMPLETED'
    )
    and (
      child.shift is null
      or to_date(substring(child.shift from '^(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') <= v_today
    );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.activate_followup_after_completion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'COMPLETED' and old.status is distinct from new.status then
    perform public.activate_due_followups();
  end if;
  return new;
end $$;

drop trigger if exists candidates_activate_followup on public.candidates;
create trigger candidates_activate_followup
after update of status on public.candidates
for each row execute function public.activate_followup_after_completion();

grant execute on function public.current_user_role()                   to authenticated;
grant execute on function public.is_staff()                            to authenticated;
grant execute on function public.is_admin()                            to authenticated;
grant execute on function public.import_form_candidates(jsonb)        to authenticated;
grant execute on function public.import_candidate_schedules(jsonb)     to authenticated;
grant execute on function public.add_walk_in_candidate(text, text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.check_in_candidate(uuid)             to authenticated;
grant execute on function public.undo_check_in(uuid)                  to authenticated;
grant execute on function public.mark_absent(uuid)                    to authenticated;
grant execute on function public.mark_absent_with_note(uuid, text)     to authenticated;
grant execute on function public.update_absent_note(uuid, text)         to authenticated;
grant execute on function public.assign_candidate(uuid, uuid)         to authenticated;
grant execute on function public.start_interview(uuid)                to authenticated;
grant execute on function public.return_to_queue(uuid)                to authenticated;
grant execute on function public.submit_evaluation(uuid, jsonb, text) to authenticated;
grant execute on function public.submit_evaluation_with_referral(uuid, jsonb, text, text) to authenticated;
grant execute on function public.admin_reset_candidate(uuid)          to authenticated;
grant execute on function public.send_table_alarm(uuid)               to authenticated;
grant execute on function public.activate_due_followups()             to authenticated;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
--  - Đọc: mọi nhân sự đã được cấp profile.
--  - Ghi trực tiếp: chỉ ADMIN (cấu hình, import thí sinh).
--  - Chuyển trạng thái: chỉ qua RPC ở trên.
--  - profiles: không ai tự sửa được role của mình; tạo/sửa tài khoản
--    đi qua server (service role key).
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.rooms           enable row level security;
alter table public.tables          enable row level security;
alter table public.candidates      enable row level security;
alter table public.rubric_criteria enable row level security;
alter table public.evaluations     enable row level security;
alter table public.ops_messages    enable row level security;
alter table public.display_calls   enable row level security;
alter table public.display_settings enable row level security;
alter table public.review_portals enable row level security;
alter table public.review_decisions enable row level security;
alter table public.review_decision_events enable row level security;
revoke all on public.review_portals, public.review_decisions, public.review_decision_events from anon, authenticated;
grant select, insert, update, delete on public.review_portals, public.review_decisions, public.review_decision_events to service_role;
revoke execute on function public.verify_review_portal(text, text) from public, anon, authenticated;
grant execute on function public.verify_review_portal(text, text) to service_role;

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('ADMIN', 'COORDINATOR'));

-- rooms
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated using (public.is_staff());
drop policy if exists rooms_admin_all on public.rooms;
create policy rooms_admin_all on public.rooms for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- tables
drop policy if exists tables_select on public.tables;
create policy tables_select on public.tables for select to authenticated using (public.is_staff());
drop policy if exists tables_admin_all on public.tables;
create policy tables_admin_all on public.tables for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- candidates
drop policy if exists candidates_select on public.candidates;
create policy candidates_select on public.candidates for select to authenticated using (public.is_staff());
drop policy if exists candidates_admin_all on public.candidates;
create policy candidates_admin_all on public.candidates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- rubric_criteria
drop policy if exists rubric_select on public.rubric_criteria;
create policy rubric_select on public.rubric_criteria for select to authenticated using (public.is_staff());
drop policy if exists rubric_admin_all on public.rubric_criteria;
create policy rubric_admin_all on public.rubric_criteria for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- evaluations: admin và điều phối xem lịch sử, giám khảo chỉ xem phiếu của mình
drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated
  using (public.current_user_role() in ('ADMIN', 'COORDINATOR') or interviewer_id = auth.uid());
drop policy if exists evaluations_admin_delete on public.evaluations;
create policy evaluations_admin_delete on public.evaluations for delete to authenticated
  using (public.is_admin());

drop policy if exists ops_messages_select on public.ops_messages;
create policy ops_messages_select on public.ops_messages for select to authenticated
  using (
    public.current_user_role() in ('ADMIN', 'COORDINATOR')
    or (candidate_id is null and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id = ops_messages.table_id
    ))
    or (candidate_id is not null and exists (
      select 1 from public.profiles p join public.candidates c on c.id = ops_messages.candidate_id
      where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id in (c.table_id, c.challenge_table_id)
    ))
  );
drop policy if exists ops_messages_chat_insert on public.ops_messages;
create policy ops_messages_chat_insert on public.ops_messages for insert to authenticated
  with check (kind = 'CHAT' and sender_id = auth.uid() and (
    public.current_user_role() in ('ADMIN', 'COORDINATOR') or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id = ops_messages.table_id
        and (candidate_id is null or exists (
          select 1 from public.candidates c where c.id = ops_messages.candidate_id
            and p.table_id in (c.table_id, c.challenge_table_id)
        ))
    )
  ));
grant select, insert on public.ops_messages to authenticated;

drop policy if exists display_calls_select on public.display_calls;
create policy display_calls_select on public.display_calls for select to authenticated
  using (public.current_user_role() in ('ADMIN', 'COORDINATOR'));
drop policy if exists display_calls_delete on public.display_calls;
create policy display_calls_delete on public.display_calls for delete to authenticated
  using (public.current_user_role() in ('ADMIN', 'COORDINATOR'));
grant select, delete on public.display_calls to authenticated;

drop policy if exists display_settings_select on public.display_settings;
create policy display_settings_select on public.display_settings for select to authenticated
  using (public.current_user_role() in ('ADMIN', 'COORDINATOR'));
drop policy if exists display_settings_update on public.display_settings;
create policy display_settings_update on public.display_settings for update to authenticated
  using (public.current_user_role() in ('ADMIN', 'COORDINATOR'))
  with check (public.current_user_role() in ('ADMIN', 'COORDINATOR'));
grant select, update on public.display_settings to authenticated;

-- ---------------------------------------------------------------------
-- REALTIME
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.candidates, public.tables, public.evaluations;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ops_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.display_calls;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.display_settings;
exception when duplicate_object then null; end $$;

-- Kênh broadcast riêng tư "ops" (giám khảo gọi điều phối): chỉ nhân sự đã đăng nhập
-- mới nghe/gửi được. Bỏ qua nếu không chạy trên Supabase (không có realtime.messages).
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists ops_broadcast_read on realtime.messages';
    execute 'drop policy if exists ops_broadcast_write on realtime.messages';
    execute $p$create policy ops_broadcast_read on realtime.messages for select to authenticated
      using (realtime.topic() = 'ops' and realtime.messages.extension = 'broadcast' and public.is_staff())$p$;
    execute $p$create policy ops_broadcast_write on realtime.messages for insert to authenticated
      with check (realtime.topic() = 'ops' and realtime.messages.extension = 'broadcast' and public.is_staff())$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- TIÊU CHÍ CHẤM MẶC ĐỊNH (chỉ chèn khi bảng còn trống)
-- ---------------------------------------------------------------------
insert into public.rubric_criteria (name, description, max_score, weight, sort_order)
select * from (values
  ('Kỹ năng giao tiếp',          'Diễn đạt rõ ràng, tự tin, lắng nghe',         10, 1.0, 1),
  ('Hiểu biết về CLB & Ban',     'Mức độ tìm hiểu về CLB và ban ứng tuyển',     10, 1.0, 2),
  ('Tư duy & giải quyết vấn đề', 'Xử lý tình huống, logic, sáng tạo',           10, 1.0, 3),
  ('Kỹ năng chuyên môn',         'Kỹ năng phù hợp với ban ứng tuyển',           10, 1.0, 4),
  ('Thái độ & tinh thần',        'Nhiệt huyết, cam kết, phù hợp văn hoá CLB',   10, 1.0, 5)
) as v(name, description, max_score, weight, sort_order)
where not exists (select 1 from public.rubric_criteria);

-- ---------------------------------------------------------------------
-- (Tuỳ chọn) Gán quyền ADMIN thủ công cho user đã tạo trong
-- Dashboard > Authentication > Users, nếu không dùng script seed:
--
-- insert into public.profiles (id, email, full_name, role)
-- select id, email, 'Chủ tịch CLB', 'ADMIN' from auth.users where email = 'admin@club.local'
-- on conflict (id) do update set role = 'ADMIN';
-- ---------------------------------------------------------------------

-- Existing projects: run after 20261108_multi_department_interviews.sql.
-- Fresh projects get the same objects from schema.sql.

alter table public.rooms add column if not exists is_challenge boolean not null default false;
alter table public.candidates add column if not exists challenge_table_id uuid references public.tables(id) on delete set null;
alter table public.candidates add column if not exists challenge_status text;
alter table public.candidates add column if not exists challenge_started_at timestamptz;
alter table public.evaluations add column if not exists challenge_scores jsonb not null default '{}'::jsonb;
alter table public.evaluations add column if not exists challenge_average_score numeric(5,2);
alter table public.evaluations add column if not exists challenge_comment text;
alter table public.evaluations add column if not exists challenge_interviewer_id uuid references public.profiles(id) on delete set null;
alter table public.evaluations add column if not exists challenge_interviewer_name text;
alter table public.evaluations add column if not exists challenge_table_label text;
alter table public.evaluations add column if not exists challenge_started_at timestamptz;
alter table public.evaluations add column if not exists challenge_ended_at timestamptz;
alter table public.evaluations add column if not exists challenge_duration_seconds int;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'candidates_challenge_status_check') then
    alter table public.candidates add constraint candidates_challenge_status_check
      check (challenge_status is null or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING','COMPLETED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'candidates_challenge_department_check') then
    alter table public.candidates add constraint candidates_challenge_department_check
      check (challenge_status is null or department in ('VH','HCTC'));
  end if;
end $$;

create index if not exists candidates_challenge_queue_idx
  on public.candidates(department, checked_in_at) where challenge_status = 'WAITING';
create index if not exists candidates_challenge_table_idx
  on public.candidates(challenge_table_id) where challenge_table_id is not null;

create or replace function public.validate_room_activation() returns trigger
language plpgsql set search_path = public as $$
declare
  v_department text;
  v_department_count integer;
begin
  if new.is_configured then
    if new.building_code is null or new.room_number is null then
      raise exception 'Chọn Tòa và Số phòng trước khi kích hoạt';
    end if;
    if (select count(*) from public.tables where room_id = new.id) not between 1 and 4 then
      raise exception 'Phòng phải có từ 1 đến 4 bàn';
    end if;
    if exists (select 1 from public.tables t where t.room_id = new.id and
      (t.department is null or not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER'))) then
      raise exception 'Mỗi bàn cần Ban và Giám khảo trước khi kích hoạt';
    end if;
    if new.is_challenge then
      select min(department), count(distinct department) into v_department, v_department_count
        from public.tables where room_id = new.id;
      if v_department not in ('VH','HCTC') or v_department_count <> 1 then
        raise exception 'Phòng thử thách chỉ được cấu hình cho một Ban: VH hoặc HCTC';
      end if;
      perform pg_advisory_xact_lock(hashtext('challenge_room:' || v_department));
      if exists (
        select 1 from public.rooms other
        where other.id <> new.id and other.is_configured and other.is_challenge
          and exists (select 1 from public.tables ot join public.tables nt on nt.room_id = new.id
            where ot.room_id = other.id and ot.department = nt.department)
      ) then raise exception 'Mỗi Ban chỉ được có một phòng thử thách đang kích hoạt'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_activation on public.rooms;
create trigger rooms_validate_activation before insert or update of is_configured, is_challenge on public.rooms
for each row execute function public.validate_room_activation();

create or replace function public.assign_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  v_configured boolean;
  v_challenge boolean;
begin
  perform public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'AVAILABLE' then raise exception 'Bàn này đang bận'; end if;
  select * into c from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.status <> 'CHECKED_IN' or c.challenge_status is not null then raise exception 'Thí sinh không ở hàng chờ phỏng vấn thường'; end if;
  select is_configured, is_challenge into v_configured, v_challenge from public.rooms where id = t.room_id;
  if not coalesce(v_configured, false) then raise exception 'Phòng chưa được kích hoạt'; end if;
  if coalesce(v_challenge, false) then raise exception 'Điều phối không thể gán thí sinh vào phòng thử thách'; end if;
  if t.department is null then raise exception 'Bàn chưa được cấu hình Ban'; end if;
  if c.department is distinct from t.department then raise exception 'Ban của thí sinh không khớp Ban phụ trách bàn'; end if;
  if not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER') then raise exception 'Bàn chưa có tài khoản đại diện'; end if;
  update public.tables set status='ASSIGNED', current_candidate_id=c.id, assigned_at=now(), started_at=null where id=t.id;
  update public.candidates set status='ASSIGNED', table_id=t.id, assigned_at=now() where id=c.id;
  perform pg_advisory_xact_lock(hashtext('display_calls:' || t.department));
  delete from public.display_calls where candidate_id=c.id;
  insert into public.display_calls(candidate_id,table_id,department,display_name,display_code,room_label)
    select c.id,t.id,t.department,c.full_name,c.code,r.name from public.rooms r where r.id=t.room_id;
  delete from public.display_calls d where d.department=t.department and d.id not in (
    select id from public.display_calls where department=t.department order by called_at desc,id desc limit 5
  );
end $$;

create or replace function public.assign_challenge_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  c public.candidates;
  v_configured boolean;
  v_challenge boolean;
begin
  v := public._require_role(array['INTERVIEWER']::public.user_role[]);
  if v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode='42501'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status <> 'AVAILABLE' then raise exception 'Bàn thử thách chưa sẵn sàng'; end if;
  select is_configured, is_challenge into v_configured, v_challenge from public.rooms where id=t.room_id;
  if not coalesce(v_configured,false) or not coalesce(v_challenge,false) then raise exception 'Tài khoản này không thuộc phòng thử thách' using errcode='42501'; end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_status <> 'WAITING' then raise exception 'Thí sinh không còn trong hàng chờ thử thách'; end if;
  if c.department is distinct from t.department then raise exception 'Thí sinh không thuộc Ban của phòng thử thách'; end if;
  update public.tables set status='ASSIGNED', current_candidate_id=c.id, assigned_at=now(), started_at=null where id=t.id;
  update public.candidates set status='ASSIGNED', challenge_status='ASSIGNED', challenge_table_id=t.id, assigned_at=now() where id=c.id;
end $$;

create or replace function public.start_interview(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  c public.candidates;
  v_challenge boolean;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode='42501'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'ASSIGNED' or t.current_candidate_id is null then raise exception 'Không có thí sinh nào đang chờ xác nhận ở bàn này'; end if;
  select is_challenge into v_challenge from public.rooms where id=t.room_id;
  select * into c from public.candidates where id=t.current_candidate_id for update;
  if v_challenge and c.challenge_status <> 'ASSIGNED' then raise exception 'Thí sinh chưa được nhận vào vòng thử thách'; end if;
  if not v_challenge and c.challenge_status is not null then raise exception 'Thí sinh thử thách không thể quay lại bàn phỏng vấn thường'; end if;
  update public.tables set status='INTERVIEWING', started_at=now() where id=t.id;
  update public.candidates set status='INTERVIEWING', interview_started_at=now(),
    challenge_status=case when v_challenge then 'INTERVIEWING' else challenge_status end,
    challenge_started_at=case when v_challenge then now() else challenge_started_at end
  where id=t.current_candidate_id;
  delete from public.display_calls where candidate_id=t.current_candidate_id;
end $$;

create or replace function public.return_to_queue(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  v_challenge boolean;
begin
  v := public._require_role(array['ADMIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode='42501'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  select is_challenge into v_challenge from public.rooms where id=t.room_id;
  if v_challenge and v.role='COORDINATOR' then raise exception 'Điều phối chỉ được xem thông tin phòng thử thách' using errcode='42501'; end if;
  if t.current_candidate_id is not null then
    if v_challenge then
      update public.candidates set status='CHECKED_IN', challenge_status='WAITING', challenge_table_id=null, assigned_at=null, interview_started_at=null, challenge_started_at=null
        where id=t.current_candidate_id and challenge_status in ('ASSIGNED','INTERVIEWING');
    else
      update public.candidates set status='CHECKED_IN', table_id=null, assigned_at=null, interview_started_at=null
        where id=t.current_candidate_id and status in ('ASSIGNED','INTERVIEWING') and challenge_status is null;
    end if;
    delete from public.display_calls where candidate_id=t.current_candidate_id;
  end if;
  update public.tables set status='AVAILABLE', current_candidate_id=null, assigned_at=null, started_at=null where id=t.id;
end $$;

create or replace function public.submit_evaluation(p_table_id uuid, p_scores jsonb, p_comment text)
returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_sum numeric:=0; v_wsum numeric:=0; v_clean jsonb:='{}'::jsonb; v_avg numeric; v_dur int;
  v_room text; v_is_challenge boolean; v_eval public.evaluations; v_challenge_room boolean;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode='42501'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status <> 'INTERVIEWING' or t.current_candidate_id is null then raise exception 'Bàn này không có buổi phỏng vấn đang diễn ra'; end if;
  select is_challenge into v_is_challenge from public.rooms where id=t.room_id;
  select * into c from public.candidates where id=t.current_candidate_id for update;
  if v_is_challenge or c.challenge_status is not null then raise exception 'Dùng chức năng nộp phiếu thử thách cho thí sinh này'; end if;
  if p_scores is null or jsonb_typeof(p_scores)<>'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"',r.name; end if;
    begin v_score:=(p_scores->>r.id::text)::numeric; exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"',r.name; end;
    if v_score is null or v_score<0 or v_score>r.max_score then raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %',r.name,r.max_score; end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,v_score); v_sum:=v_sum+(v_score/r.max_score)*10*r.weight; v_wsum:=v_wsum+r.weight;
  end loop;
  v_avg:=case when v_wsum>0 then round(v_sum/v_wsum,2) end;
  v_dur:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  insert into public.evaluations as e(candidate_id,table_id,interviewer_id,interviewer_name,table_label,scores,average_score,comment,started_at,ended_at,duration_seconds)
  values(c.id,t.id,v.id,coalesce(nullif(v.full_name,''),v.email),coalesce(v_room,'')||' - '||t.name,v_clean,v_avg,left(nullif(trim(p_comment),''),5000),t.started_at,now(),v_dur)
  on conflict(candidate_id) do update set table_id=excluded.table_id,interviewer_id=excluded.interviewer_id,interviewer_name=excluded.interviewer_name,table_label=excluded.table_label,scores=excluded.scores,average_score=excluded.average_score,comment=excluded.comment,started_at=excluded.started_at,ended_at=excluded.ended_at,duration_seconds=excluded.duration_seconds,created_at=now()
  returning * into v_eval;

  if c.department in ('VH','HCTC') then
    select exists(select 1 from public.rooms rr join public.tables tt on tt.room_id=rr.id where rr.is_configured and rr.is_challenge and tt.department=c.department) into v_challenge_room;
    if not v_challenge_room then raise exception 'Admin cần kích hoạt phòng thử thách cho Ban % trước khi nộp',c.department; end if;
    update public.candidates set status='CHECKED_IN',challenge_status='WAITING',challenge_table_id=null,interview_ended_at=now(),duration_seconds=v_dur where id=c.id;
  else
    update public.candidates set status='COMPLETED',interview_ended_at=now(),duration_seconds=v_dur where id=c.id;
  end if;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,started_at=null where id=t.id;
  return v_eval;
end $$;

create or replace function public.submit_challenge_evaluation(p_table_id uuid,p_scores jsonb,p_comment text)
returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_sum numeric:=0; v_wsum numeric:=0; v_clean jsonb:='{}'::jsonb; v_avg numeric; v_dur int;
  v_room text; v_eval public.evaluations;
begin
  v:=public._require_role(array['INTERVIEWER']::public.user_role[]);
  if v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode='42501'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status <> 'INTERVIEWING' or t.current_candidate_id is null then raise exception 'Bàn thử thách chưa có ca đang diễn ra'; end if;
  if not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge) then raise exception 'Đây không phải phòng thử thách' using errcode='42501'; end if;
  select * into c from public.candidates where id=t.current_candidate_id for update;
  if c.challenge_status <> 'INTERVIEWING' or c.department is distinct from t.department then raise exception 'Thí sinh không ở đúng vòng thử thách'; end if;
  if p_scores is null or jsonb_typeof(p_scores)<>'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"',r.name; end if;
    begin v_score:=(p_scores->>r.id::text)::numeric; exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"',r.name; end;
    if v_score is null or v_score<0 or v_score>r.max_score then raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %',r.name,r.max_score; end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,v_score); v_sum:=v_sum+(v_score/r.max_score)*10*r.weight; v_wsum:=v_wsum+r.weight;
  end loop;
  v_avg:=case when v_wsum>0 then round(v_sum/v_wsum,2) end;
  v_dur:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  update public.evaluations set challenge_scores=v_clean,challenge_average_score=v_avg,challenge_comment=left(nullif(trim(p_comment),''),5000),
    challenge_interviewer_id=v.id,challenge_interviewer_name=coalesce(nullif(v.full_name,''),v.email),challenge_table_label=coalesce(v_room,'')||' - '||t.name,
    challenge_started_at=t.started_at,challenge_ended_at=now(),challenge_duration_seconds=v_dur
  where candidate_id=c.id returning * into v_eval;
  if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
  update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now() where id=c.id;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,started_at=null where id=t.id;
  return v_eval;
end $$;

create or replace function public.admin_reset_candidate(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  delete from public.display_calls where candidate_id=p_candidate_id;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,started_at=null where current_candidate_id=p_candidate_id;
  delete from public.evaluations where candidate_id=p_candidate_id;
  update public.candidates set status='NOT_ARRIVED',checked_in_at=null,table_id=null,challenge_table_id=null,challenge_status=null,challenge_started_at=null,assigned_at=null,interview_started_at=null,interview_ended_at=null,duration_seconds=null,absent_at=null where id=p_candidate_id;
end $$;

drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated
  using (public.is_admin() or interviewer_id=auth.uid() or exists (
    select 1 from public.candidates c join public.tables t on t.id=c.challenge_table_id
    join public.profiles p on p.table_id=t.id and p.id=auth.uid()
    join public.rooms r on r.id=t.room_id and r.is_challenge
    where c.id=evaluations.candidate_id and p.role='INTERVIEWER' and t.status in ('ASSIGNED','INTERVIEWING')
  ));

revoke execute on function public.assign_challenge_candidate(uuid,uuid) from public,anon;
revoke execute on function public.submit_challenge_evaluation(uuid,jsonb,text) from public,anon;
grant execute on function public.assign_challenge_candidate(uuid,uuid) to authenticated;
grant execute on function public.submit_challenge_evaluation(uuid,jsonb,text) to authenticated;

-- Latest department-specific challenge modes. Kept in sync with migration 20261114_department_challenge_modes.sql.
-- Existing projects: run after the challenge interview and absence-note migrations.
-- VH uses an external second round; HCTC continues into a staffed Debate room.

alter table public.rooms add column if not exists external_challenge boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rooms_challenge_mode_check' and conrelid = 'public.rooms'::regclass) then
    alter table public.rooms add constraint rooms_challenge_mode_check
      check (not (is_challenge and external_challenge));
  end if;
end $$;

create or replace function public.validate_room_activation() returns trigger
language plpgsql set search_path = public as $$
declare
  v_department text;
  v_department_count integer;
begin
  if new.external_challenge and new.is_challenge then
    raise exception 'Chọn một chế độ thử thách cho phòng';
  end if;
  if new.is_configured then
    if new.building_code is null or new.room_number is null then
      raise exception 'Chọn Tòa và Số phòng trước khi kích hoạt';
    end if;
    if (select count(*) from public.tables where room_id = new.id) not between 1 and 4 then
      raise exception 'Phòng phải có từ 1 đến 4 bàn';
    end if;
    if exists (select 1 from public.tables t where t.room_id = new.id and
      (t.department is null or not exists (
        select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER'
      ))) then
      raise exception 'Mỗi bàn cần Ban và Giám khảo trước khi kích hoạt';
    end if;
    if new.is_challenge or new.external_challenge then
      select min(department), count(distinct department)
        into v_department, v_department_count
        from public.tables where room_id = new.id;
      if v_department_count <> 1 then raise exception 'Mỗi phòng chỉ cấu hình cho một Ban'; end if;
      if new.is_challenge and v_department <> 'HCTC' then
        raise exception 'Phòng Debate chỉ dành cho Ban HCTC';
      end if;
      if new.external_challenge and v_department <> 'VH' then
        raise exception 'Thử thách ngoài phòng chỉ dành cho Ban Văn hoá';
      end if;
      if new.is_challenge then
        perform pg_advisory_xact_lock(hashtext('challenge_room:HCTC'));
        if exists (select 1 from public.rooms other where other.id <> new.id and other.is_configured and other.is_challenge) then
          raise exception 'Ban HCTC chỉ được có một phòng Debate đang kích hoạt';
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_activation on public.rooms;
create trigger rooms_validate_activation before insert or update of is_configured, is_challenge, external_challenge on public.rooms
for each row execute function public.validate_room_activation();

-- Convert an older VH Debate setup into the new no-room flow. Existing judge
-- accounts remain intact but the former Debate room is taken out of service.
update public.profiles p set table_id = null
where p.table_id in (
  select t.id from public.tables t join public.rooms r on r.id = t.room_id
  where r.is_challenge and t.department = 'VH'
);
update public.rooms r set is_configured = false, is_challenge = false, external_challenge = false
where r.is_challenge and exists (select 1 from public.tables t where t.room_id = r.id and t.department = 'VH');
update public.rooms r set external_challenge = true
where r.is_configured and not r.is_challenge
  and exists (select 1 from public.tables t where t.room_id = r.id and t.department = 'VH')
  and not exists (select 1 from public.tables t where t.room_id = r.id and t.department <> 'VH');

create or replace function public.start_interview(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  c public.candidates;
  v_challenge boolean;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'ASSIGNED' or t.current_candidate_id is null then
    raise exception 'Không có thí sinh nào đang chờ xác nhận ở bàn này';
  end if;
  select is_challenge into v_challenge from public.rooms where id = t.room_id;
  select * into c from public.candidates where id = t.current_candidate_id for update;
  if v_challenge and (c.challenge_status <> 'ASSIGNED' or c.department <> 'HCTC') then
    raise exception 'Chỉ nhận đúng thí sinh ở vòng Debate HCTC';
  end if;
  if not v_challenge and c.challenge_status is not null then
    raise exception 'Thí sinh đã chuyển vòng 2 không thể quay lại bàn phỏng vấn thường';
  end if;
  update public.tables set status = 'INTERVIEWING', started_at = now() where id = t.id;
  update public.candidates set status = 'INTERVIEWING', interview_started_at = now(),
    challenge_status = case when v_challenge then 'INTERVIEWING' else challenge_status end,
    challenge_started_at = case when v_challenge then coalesce(challenge_started_at, now()) else challenge_started_at end
  where id = t.current_candidate_id;
  delete from public.display_calls where candidate_id = t.current_candidate_id;
end $$;

create or replace function public.assign_challenge_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  c public.candidates;
begin
  v := public._require_role(array['INTERVIEWER']::public.user_role[]);
  if v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501'; end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found or t.status <> 'AVAILABLE' then raise exception 'Bàn Debate chưa sẵn sàng'; end if;
  if not exists (select 1 from public.rooms where id = t.room_id and is_configured and is_challenge) or t.department <> 'HCTC' then
    raise exception 'Tài khoản này không thuộc phòng Debate HCTC' using errcode = '42501';
  end if;
  select * into c from public.candidates where id = p_candidate_id for update;
  if not found or c.challenge_status <> 'WAITING' or c.status <> 'CHECKED_IN' then
    raise exception 'Thí sinh không còn trong hàng chờ Debate';
  end if;
  if c.department <> 'HCTC' then raise exception 'Phòng Debate chỉ nhận thí sinh HCTC'; end if;
  update public.tables set status = 'ASSIGNED', current_candidate_id = c.id, assigned_at = now(), started_at = null where id = t.id;
  update public.candidates set status = 'ASSIGNED', challenge_status = 'ASSIGNED', challenge_table_id = t.id, assigned_at = now() where id = c.id;
end $$;

create or replace function public.return_to_queue(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
  v_challenge boolean;
begin
  v := public._require_role(array['ADMIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  select is_challenge into v_challenge from public.rooms where id = t.room_id;
  if v_challenge and v.role = 'COORDINATOR' then raise exception 'Điều phối chỉ được xem thông tin phòng Debate' using errcode = '42501'; end if;
  if t.current_candidate_id is not null then
    if v_challenge then
      -- Keep the original transfer timestamp so room wait time remains accurate.
      update public.candidates set status = 'CHECKED_IN', challenge_status = 'WAITING', challenge_table_id = null,
        assigned_at = null, interview_started_at = null
       where id = t.current_candidate_id and challenge_status in ('ASSIGNED','INTERVIEWING');
    else
      update public.candidates set status = 'CHECKED_IN', table_id = null, assigned_at = null, interview_started_at = null
       where id = t.current_candidate_id and status in ('ASSIGNED','INTERVIEWING') and challenge_status is null;
    end if;
    delete from public.display_calls where candidate_id = t.current_candidate_id;
  end if;
  update public.tables set status = 'AVAILABLE', current_candidate_id = null, assigned_at = null, started_at = null where id = t.id;
end $$;

create or replace function public.submit_evaluation(p_table_id uuid, p_scores jsonb, p_comment text)
returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_sum numeric := 0; v_wsum numeric := 0; v_clean jsonb := '{}'::jsonb; v_avg numeric; v_dur int;
  v_room text; v_external_challenge boolean; v_eval public.evaluations; v_debate_room boolean;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501'; end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found or t.status <> 'INTERVIEWING' or t.current_candidate_id is null then raise exception 'Bàn này không có buổi phỏng vấn đang diễn ra'; end if;
  select external_challenge, is_challenge into v_external_challenge, v_debate_room from public.rooms where id = t.room_id;
  select * into c from public.candidates where id = t.current_candidate_id for update;
  if v_debate_room or c.challenge_status is not null then raise exception 'Dùng chức năng nộp phiếu thử thách cho thí sinh này'; end if;
  if p_scores is null or jsonb_typeof(p_scores) <> 'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order, created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"', r.name; end if;
    begin v_score := (p_scores ->> r.id::text)::numeric; exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"', r.name; end;
    if v_score is null or v_score < 0 or v_score > r.max_score then raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %', r.name, r.max_score; end if;
    v_clean := v_clean || jsonb_build_object(r.id::text, v_score);
    v_sum := v_sum + (v_score / r.max_score) * 10 * r.weight;
    v_wsum := v_wsum + r.weight;
  end loop;
  v_avg := case when v_wsum > 0 then round(v_sum / v_wsum, 2) end;
  v_dur := greatest(0, floor(extract(epoch from (now() - coalesce(t.started_at, now())))))::int;
  select name into v_room from public.rooms where id = t.room_id;
  insert into public.evaluations as e(candidate_id, table_id, interviewer_id, interviewer_name, table_label, scores, average_score, comment, started_at, ended_at, duration_seconds)
  values(c.id, t.id, v.id, coalesce(nullif(v.full_name, ''), v.email), coalesce(v_room, '') || ' - ' || t.name, v_clean, v_avg, left(nullif(trim(p_comment), ''), 5000), t.started_at, now(), v_dur)
  on conflict(candidate_id) do update set table_id = excluded.table_id, interviewer_id = excluded.interviewer_id,
    interviewer_name = excluded.interviewer_name, table_label = excluded.table_label, scores = excluded.scores,
    average_score = excluded.average_score, comment = excluded.comment, started_at = excluded.started_at,
    ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds, created_at = now()
  returning * into v_eval;

  if c.department = 'HCTC' then
    select exists(select 1 from public.rooms rr join public.tables tt on tt.room_id = rr.id
      where rr.is_configured and rr.is_challenge and tt.department = 'HCTC') into v_debate_room;
    if not v_debate_room then raise exception 'Admin cần kích hoạt phòng Debate HCTC trước khi nộp'; end if;
    update public.candidates set status = 'CHECKED_IN', challenge_status = 'WAITING', challenge_table_id = null,
      challenge_started_at = now(), interview_ended_at = now(), duration_seconds = v_dur where id = c.id;
  elsif c.department = 'VH' and coalesce(v_external_challenge, false) then
    update public.candidates set status = 'CHECKED_IN', challenge_status = 'WAITING', challenge_table_id = null,
      challenge_started_at = now(), interview_ended_at = now(), duration_seconds = v_dur where id = c.id;
  else
    update public.candidates set status = 'COMPLETED', interview_ended_at = now(), duration_seconds = v_dur where id = c.id;
  end if;
  update public.tables set status = 'AVAILABLE', current_candidate_id = null, assigned_at = null, started_at = null where id = t.id;
  return v_eval;
end $$;

create or replace function public.finish_external_challenge(p_candidate_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  c public.candidates;
begin
  v := public._require_role(array['INTERVIEWER']::public.user_role[]);
  select * into c from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.department <> 'VH' or c.challenge_status <> 'WAITING' or c.status <> 'CHECKED_IN' then
    raise exception 'Chỉ xác nhận được thí sinh Văn hoá đang ở vòng thử thách ngoài phòng';
  end if;
  if c.table_id is distinct from v.table_id or not exists (
    select 1 from public.rooms r where r.id = (select room_id from public.tables where id = v.table_id)
      and r.is_configured and r.external_challenge
  ) or not exists (select 1 from public.evaluations e where e.candidate_id = c.id and e.table_id = c.table_id) then
    raise exception 'Bạn không phụ trách vòng 1 của thí sinh này' using errcode = '42501';
  end if;
  update public.candidates set status = 'COMPLETED', challenge_status = 'COMPLETED', interview_ended_at = now()
   where id = c.id;
end $$;

revoke execute on function public.finish_external_challenge(uuid) from public, anon;
grant execute on function public.finish_external_challenge(uuid) to authenticated;
notify pgrst, 'reload schema';

-- Latest table pause and Support IT role policies. Kept in sync with migration 20261116_table_pause_support_chat.sql.
-- Run after 20261115_support_it_role.sql.

alter table public.tables add column if not exists is_paused boolean not null default false;
alter table public.ops_messages add column if not exists sender_label text;

-- Pause is a separate flag so a table can finish its current interview while
-- refusing the next assignment.
create or replace function public.validate_table_pause() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_paused and exists (
    select 1 from public.rooms r where r.id = new.room_id and (r.is_challenge or r.external_challenge)
  ) then
    raise exception 'Không thể tạm dừng bàn Debate hoặc bàn thử thách đặc biệt';
  end if;
  if new.status = 'ASSIGNED' and new.is_paused then
    if tg_op = 'INSERT' then
      raise exception 'Bàn đang tạm dừng tiếp nhận thí sinh';
    elsif old.status is distinct from 'ASSIGNED' then
      raise exception 'Bàn đang tạm dừng tiếp nhận thí sinh';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tables_validate_pause on public.tables;
create trigger tables_validate_pause before insert or update of status, is_paused, room_id on public.tables
for each row execute function public.validate_table_pause();

create or replace function public.validate_no_paused_special_room() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_configured and (new.is_challenge or new.external_challenge) and exists (
    select 1 from public.tables t where t.room_id = new.id and t.is_paused
  ) then
    raise exception 'Mở lại tiếp nhận ở mọi bàn trước khi kích hoạt chế độ Debate/thử thách';
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_no_paused_special on public.rooms;
create trigger rooms_validate_no_paused_special before insert or update of is_configured, is_challenge, external_challenge on public.rooms
for each row execute function public.validate_no_paused_special_room();

create or replace function public.set_table_paused(p_table_id uuid, p_paused boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  t public.tables;
begin
  v := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if v.role = 'INTERVIEWER' and v.table_id is distinct from t.id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  if exists (select 1 from public.rooms r where r.id = t.room_id and (r.is_challenge or r.external_challenge)) then
    raise exception 'Không thể tạm dừng bàn Debate hoặc bàn thử thách đặc biệt';
  end if;
  update public.tables set is_paused = p_paused where id = t.id;
end $$;
revoke execute on function public.set_table_paused(uuid, boolean) from public, anon;
grant execute on function public.set_table_paused(uuid, boolean) to authenticated;

-- Protect assignment RPCs and direct writes alike.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('ADMIN','SUPPORT_IT'))
$$;

create or replace function public._require_role(p_roles public.user_role[]) returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid();
  if v.id is null or not (v.role = any (p_roles) or (v.role = 'SUPPORT_IT' and 'ADMIN' = any (p_roles))) then
    raise exception 'Bạn không có quyền thực hiện thao tác này' using errcode = '42501';
  end if;
  return v;
end $$;

-- RLS policies that previously checked the literal ADMIN role now use the
-- shared admin predicate so Support IT has the same capabilities.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin() or public.current_user_role() = 'COORDINATOR');

drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR' or interviewer_id = auth.uid() or exists (
    select 1 from public.candidates c join public.tables t on t.id = c.challenge_table_id
    join public.profiles p on p.table_id = t.id and p.id = auth.uid()
    join public.rooms r on r.id = t.room_id and r.is_challenge
    where c.id = evaluations.candidate_id and p.role = 'INTERVIEWER' and t.status in ('ASSIGNED','INTERVIEWING')
  ));

drop policy if exists ops_messages_select on public.ops_messages;
create policy ops_messages_select on public.ops_messages for select to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR' or
    (candidate_id is null and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id = ops_messages.table_id
    )) or
    (candidate_id is not null and exists (
      select 1 from public.profiles p join public.candidates c on c.id = ops_messages.candidate_id
      where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id in (c.table_id, c.challenge_table_id)
    )));

drop policy if exists ops_messages_chat_insert on public.ops_messages;
create policy ops_messages_chat_insert on public.ops_messages for insert to authenticated
  with check (kind = 'CHAT' and sender_id = auth.uid() and (
    public.is_admin() or public.current_user_role() = 'COORDINATOR' or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'INTERVIEWER' and p.table_id = ops_messages.table_id
        and (candidate_id is null or exists (
          select 1 from public.candidates c where c.id = ops_messages.candidate_id
            and p.table_id in (c.table_id, c.challenge_table_id)
        ))
    )
  ));

drop policy if exists display_calls_select on public.display_calls;
create policy display_calls_select on public.display_calls for select to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR');
drop policy if exists display_calls_delete on public.display_calls;
create policy display_calls_delete on public.display_calls for delete to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR');
drop policy if exists display_settings_select on public.display_settings;
create policy display_settings_select on public.display_settings for select to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR');
drop policy if exists display_settings_update on public.display_settings;
create policy display_settings_update on public.display_settings for update to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR')
  with check (public.is_admin() or public.current_user_role() = 'COORDINATOR');

create or replace function public.set_ops_sender_label() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = new.sender_id;
  new.sender_label := case v_role
    when 'SUPPORT_IT' then 'Support IT'
    when 'ADMIN' then 'Điều phối'
    when 'COORDINATOR' then 'Điều phối'
    when 'INTERVIEWER' then 'Giám khảo'
    else 'Nhân sự'
  end;
  return new;
end $$;
drop trigger if exists ops_messages_set_sender_label on public.ops_messages;
create trigger ops_messages_set_sender_label before insert on public.ops_messages
for each row execute function public.set_ops_sender_label();
update public.ops_messages m set sender_label = case p.role
  when 'SUPPORT_IT' then 'Support IT'
  when 'ADMIN' then 'Điều phối'
  when 'COORDINATOR' then 'Điều phối'
  when 'INTERVIEWER' then 'Giám khảo'
  else 'Nhân sự'
end
from public.profiles p where m.sender_id = p.id and m.sender_label is null;

notify pgrst, 'reload schema';














-- Run after 20261116_table_pause_support_chat.sql.
-- Adds Chuyen Mon / Truyen Thong specializations and removes DE as a department.

alter table public.candidates add column if not exists specialization text;
alter table public.rooms add column if not exists specialization text;

-- Legacy DE meant the old standalone Design department. It now belongs to TT.
update public.candidates set department = 'TT', specialization = coalesce(specialization, 'DESIGN')
where upper(trim(coalesce(department,''))) in ('DE','DESIGN');
-- Mark legacy rooms before migrating their table department codes.
update public.rooms r set specialization = 'DESIGN'
where r.specialization is null
  and exists (select 1 from public.tables t where t.room_id = r.id and t.department = 'DE')
  and not exists (select 1 from public.tables t where t.room_id = r.id and t.department <> 'DE');
update public.tables set department = 'TT' where department = 'DE';
update public.display_calls set department = 'TT' where department = 'DE';
alter table public.review_decisions disable trigger review_decisions_validate;
update public.review_decisions set department = 'TT' where department = 'DE';
alter table public.review_decisions enable trigger review_decisions_validate;
update public.review_decision_events set department = 'TT' where department = 'DE';
delete from public.review_portals where department = 'DE';

-- Replace department checks without touching the BE/DE/EP/AL building-code check.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass as table_name, conname
    from pg_constraint
    where contype = 'c'
      and conrelid in (
        'public.tables'::regclass, 'public.candidates'::regclass,
        'public.display_calls'::regclass, 'public.review_portals'::regclass,
        'public.review_decisions'::regclass, 'public.review_decision_events'::regclass
      )
      and pg_get_constraintdef(oid) ilike '%department%'
      and pg_get_constraintdef(oid) ilike '%DE%'
  loop
    execute format('alter table %s drop constraint %I', c.table_name, c.conname);
  end loop;
end $$;

alter table public.tables drop constraint if exists tables_department_check;
alter table public.candidates drop constraint if exists candidates_department_check;
alter table public.display_calls drop constraint if exists display_calls_department_check;
alter table public.review_portals drop constraint if exists review_portals_department_check;
alter table public.review_decisions drop constraint if exists review_decisions_department_check;
alter table public.review_decision_events drop constraint if exists review_decision_events_department_check;
alter table public.tables add constraint tables_department_check
  check (department in ('CM','VH','TT','ND','HCTC'));
alter table public.candidates add constraint candidates_department_check
  check (department is null or department in ('CM','VH','TT','ND','HCTC'));
alter table public.display_calls add constraint display_calls_department_check
  check (department in ('CM','VH','TT','ND','HCTC'));
alter table public.review_portals add constraint review_portals_department_check
  check (department in ('CM','VH','TT','ND','HCTC'));
alter table public.review_decisions add constraint review_decisions_department_check
  check (department in ('CM','VH','TT','ND','HCTC'));
alter table public.review_decision_events add constraint review_decision_events_department_check
  check (department in ('CM','VH','TT','ND','HCTC'));

alter table public.candidates drop constraint if exists candidates_specialization_check;
alter table public.rooms drop constraint if exists rooms_specialization_check;
alter table public.candidates add constraint candidates_specialization_check check (
  specialization is null or
  (department = 'CM' and specialization in ('HAT','NHAC_CU','RAP')) or
  (department = 'TT' and specialization in ('MEDIA','DESIGN','CONTENT'))
);
alter table public.rooms add constraint rooms_specialization_check check (
  specialization is null or specialization in ('HAT','NHAC_CU','RAP','MEDIA','DESIGN','CONTENT')
);

create index if not exists candidates_department_specialization_idx
  on public.candidates(department, specialization, status);
create index if not exists rooms_specialization_idx on public.rooms(specialization);

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text, p_second_department text default null
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  v_eval public.evaluations;
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is not null then
    if p_second_department not in ('VH','TT','ND','HCTC') then raise exception 'Ban thứ hai không hợp lệ'; end if;
    if p_second_department='TT' then raise exception 'Cần chọn ngạch Truyền Thông qua RPC mới'; end if;
    select * into t from public.tables where id=p_table_id for update;
    if t.department is distinct from 'CM' or t.current_candidate_id is null then raise exception 'Chỉ bàn Chuyên Môn được chọn Ban thứ hai'; end if;
    select * into c from public.candidates where id=t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then raise exception 'Chỉ thí sinh Chuyên Môn gốc được phỏng vấn Ban thứ hai'; end if;
    if exists(select 1 from public.candidates where source_candidate_id=c.id) then raise exception 'Thí sinh đã có lượt phỏng vấn Ban thứ hai'; end if;
  end if;
  v_eval := public.submit_evaluation(p_table_id,p_scores,p_comment);
  if p_second_department is not null then
    insert into public.candidates(code,full_name,student_cohort,gender,facebook_url,phone,email,department,shift,cv_url,source_candidate_id,status,checked_in_at)
    values(public._next_candidate_code(),c.full_name,c.student_cohort,c.gender,c.facebook_url,c.phone,c.email,p_second_department,c.shift,c.cv_url,c.id,'CHECKED_IN',now());
  end if;
  return v_eval;
end $$;

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text, p_second_department text, p_second_specialization text
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  v_eval public.evaluations;
  v_specialization text := nullif(upper(btrim(coalesce(p_second_specialization,''))), '');
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is null then
    if v_specialization is not null then raise exception 'Không chọn ngạch khi chưa chọn Ban thứ hai'; end if;
  else
    if p_second_department not in ('VH','TT','ND','HCTC') then raise exception 'Ban thứ hai không hợp lệ'; end if;
    if p_second_department='TT' and (v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT')) then raise exception 'Chọn ngạch Truyền Thông cho lượt thứ hai'; end if;
    if p_second_department<>'TT' and v_specialization is not null then raise exception 'Ngạch chỉ áp dụng cho Truyền Thông ở lượt thứ hai'; end if;
    select * into t from public.tables where id=p_table_id for update;
    if t.department is distinct from 'CM' or t.current_candidate_id is null then raise exception 'Chỉ bàn Chuyên Môn được chọn Ban thứ hai'; end if;
    select * into c from public.candidates where id=t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then raise exception 'Chỉ thí sinh Chuyên Môn gốc được phỏng vấn Ban thứ hai'; end if;
    if exists(select 1 from public.candidates where source_candidate_id=c.id) then raise exception 'Thí sinh đã có lượt phỏng vấn Ban thứ hai'; end if;
  end if;
  v_eval := public.submit_evaluation(p_table_id,p_scores,p_comment);
  if p_second_department is not null then
    insert into public.candidates(code,full_name,student_cohort,gender,facebook_url,phone,email,department,specialization,shift,cv_url,source_candidate_id,status,checked_in_at)
    values(public._next_candidate_code(),c.full_name,c.student_cohort,c.gender,c.facebook_url,c.phone,c.email,p_second_department,v_specialization,c.shift,c.cv_url,c.id,'CHECKED_IN',now());
  end if;
  return v_eval;
end $$;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) from public,anon;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) to authenticated;

create or replace function public.import_form_candidates(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_number text;
  v_email text;
  v_department text;
  v_specialization text;
  v_existing public.candidates;
  v_application public.candidates;
  v_count integer := 0;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'File phải có từ 1 đến 5000 thí sinh';
  end if;
  for v_row in select * from jsonb_to_recordset(p_rows) as x(
    student_number text, full_name text, student_cohort text, gender text,
    phone text, email text, facebook_url text, department text, specialization text
  ) loop
    v_number := upper(btrim(coalesce(v_row.student_number, '')));
    v_email := lower(nullif(btrim(coalesce(v_row.email, '')), ''));
    v_department := upper(btrim(coalesce(v_row.department, '')));
    v_specialization := nullif(upper(btrim(coalesce(v_row.specialization, ''))), '');
    if v_number !~ '^[A-Z0-9]{8}$' and v_email is null then raise exception 'MSSV chưa hợp lệ và không có Email để nhận diện'; end if;
    if length(btrim(coalesce(v_row.full_name, ''))) not between 1 and 200 then raise exception 'Họ tên không hợp lệ'; end if;
    if v_row.gender not in ('NAM','NU','KHAC') then raise exception 'Giới tính không hợp lệ'; end if;
    if v_department not in ('CM','VH','TT','ND','HCTC') then raise exception 'Ban không hợp lệ'; end if;
    if v_department in ('CM','TT') then
      if (v_department='CM' and v_specialization is not null and v_specialization not in ('HAT','NHAC_CU','RAP')) or
         (v_department='TT' and v_specialization is not null and v_specialization not in ('MEDIA','DESIGN','CONTENT')) then
        raise exception 'Ngạch không khớp Ban';
      end if;
    elsif v_specialization is not null then raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông'; end if;
    if length(btrim(coalesce(v_row.student_cohort,''))) > 32 or length(btrim(coalesce(v_row.phone,''))) > 32 or
       length(coalesce(v_email,'')) > 200 or length(btrim(coalesce(v_row.facebook_url,''))) > 2000 then
      raise exception 'Thông tin cá nhân vượt quá độ dài cho phép';
    end if;

    if v_number ~ '^[A-Z0-9]{8}$' then
      select * into v_existing from public.candidates where student_number=v_number and source_candidate_id is null for update;
    else
      select * into v_existing from public.candidates where lower(email)=v_email and source_candidate_id is null for update;
    end if;
    if found then
      if v_existing.department = v_department then
        v_application := v_existing;
      else
        select * into v_application from public.candidates where source_candidate_id=v_existing.id and department=v_department for update;
        if not found then
          insert into public.candidates(code,full_name,student_cohort,gender,phone,email,facebook_url,department,specialization,source_candidate_id,status)
          values(public._next_candidate_code(),btrim(v_row.full_name),nullif(btrim(v_row.student_cohort),''),v_row.gender,
            nullif(btrim(v_row.phone),''),v_email,nullif(btrim(v_row.facebook_url),''),v_department,v_specialization,v_existing.id,'NOT_ARRIVED')
          returning * into v_application;
        end if;
      end if;
      update public.candidates set full_name=btrim(v_row.full_name),student_cohort=nullif(btrim(v_row.student_cohort),''),
        gender=v_row.gender,phone=nullif(btrim(v_row.phone),''),email=v_email,facebook_url=nullif(btrim(v_row.facebook_url),''),
        specialization=coalesce(v_specialization,specialization) where id=v_application.id;
    else
      insert into public.candidates(code,student_number,student_number_raw,full_name,student_cohort,gender,phone,email,facebook_url,department,specialization,status)
      values(public._next_candidate_code(),case when v_number ~ '^[A-Z0-9]{8}$' then v_number else null end,
        case when v_number !~ '^[A-Z0-9]{8}$' then v_number end,btrim(v_row.full_name),nullif(btrim(v_row.student_cohort),''),v_row.gender,
        nullif(btrim(v_row.phone),''),v_email,nullif(btrim(v_row.facebook_url),''),v_department,v_specialization,'NOT_ARRIVED');
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.validate_room_activation() returns trigger
language plpgsql set search_path = public as $$
declare
  v_department text;
  v_department_count integer;
begin
  if new.external_challenge and new.is_challenge then
    raise exception 'Chọn một chế độ thử thách cho phòng';
  end if;
  if new.is_configured then
    if new.building_code is null or new.room_number is null then
      raise exception 'Chọn Tòa và Số phòng trước khi kích hoạt';
    end if;
    if (select count(*) from public.tables where room_id = new.id) not between 1 and 4 then
      raise exception 'Phòng phải có từ 1 đến 4 bàn';
    end if;
    if exists (select 1 from public.tables t where t.room_id = new.id and
      (t.department is null or not exists (
        select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER'
      ))) then
      raise exception 'Mỗi bàn cần Ban và Giám khảo trước khi kích hoạt';
    end if;

    select min(department), count(distinct department)
      into v_department, v_department_count from public.tables where room_id = new.id;
    if v_department in ('CM','TT') then
      if v_department_count <> 1 then
        raise exception 'Phòng Chuyên Môn hoặc Truyền Thông chỉ được phụ trách một Ban';
      end if;
      if (v_department = 'CM' and (new.specialization is null or new.specialization not in ('HAT','NHAC_CU','RAP'))) or
         (v_department = 'TT' and (new.specialization is null or new.specialization not in ('MEDIA','DESIGN','CONTENT'))) then
        raise exception 'Chọn ngạch phù hợp với Ban của phòng trước khi kích hoạt';
      end if;
    elsif new.specialization is not null then
      raise exception 'Ngạch chỉ áp dụng cho phòng Chuyên Môn và Truyền Thông';
    end if;

    if new.is_challenge or new.external_challenge then
      if v_department_count <> 1 then raise exception 'Mỗi phòng thử thách chỉ cấu hình cho một Ban'; end if;
      if new.is_challenge and v_department <> 'HCTC' then
        raise exception 'Phòng Debate chỉ dành cho Ban HCTC';
      end if;
      if new.external_challenge and v_department <> 'VH' then
        raise exception 'Thử thách ngoài phòng chỉ dành cho Ban Văn hóa';
      end if;
      if new.is_challenge then
        perform pg_advisory_xact_lock(hashtext('challenge_room:HCTC'));
        if exists (select 1 from public.rooms other where other.id <> new.id and other.is_configured and other.is_challenge) then
          raise exception 'Ban HCTC chỉ được có một phòng Debate đang kích hoạt';
        end if;
      end if;
    end if;
    if exists (select 1 from public.tables t where t.room_id = new.id and t.is_paused) and
      (new.is_challenge or new.external_challenge) then
      raise exception 'Mở lại tiếp nhận ở mọi bàn trước khi kích hoạt chế độ Debate/thử thách';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_activation on public.rooms;
create trigger rooms_validate_activation
  before insert or update of is_configured, is_challenge, external_challenge, specialization on public.rooms
  for each row execute function public.validate_room_activation();

create or replace function public.assign_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  r public.rooms;
begin
  perform public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'AVAILABLE' then raise exception 'Bàn này đang bận'; end if;
  if t.is_paused then raise exception 'Bàn đang tạm dừng tiếp nhận thí sinh'; end if;
  select * into c from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.status <> 'CHECKED_IN' or c.challenge_status is not null then raise exception 'Thí sinh không ở hàng chờ phỏng vấn thường'; end if;
  select * into r from public.rooms where id = t.room_id;
  if not coalesce(r.is_configured, false) then raise exception 'Phòng chưa được kích hoạt'; end if;
  if coalesce(r.is_challenge, false) then raise exception 'Điều phối không thể gán thí sinh vào phòng thử thách'; end if;
  if t.department is null then raise exception 'Bàn chưa được cấu hình Ban'; end if;
  if c.department is distinct from t.department then raise exception 'Ban của thí sinh không khớp Ban phụ trách bàn'; end if;
  if t.department in ('CM','TT') then
    if c.specialization is null then raise exception 'Admin cần gán ngạch cho thí sinh trước khi điều phối'; end if;
    if r.specialization is distinct from c.specialization then raise exception 'Ngạch của thí sinh không khớp ngạch phụ trách phòng'; end if;
  elsif c.specialization is not null or r.specialization is not null then
    raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông';
  end if;
  if not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER') then
    raise exception 'Bàn chưa có tài khoản đại diện';
  end if;
  update public.tables set status='ASSIGNED', current_candidate_id=c.id, assigned_at=now(), started_at=null where id=t.id;
  update public.candidates set status='ASSIGNED', table_id=t.id, assigned_at=now() where id=c.id;
  perform pg_advisory_xact_lock(hashtext('display_calls:' || t.department));
  delete from public.display_calls where candidate_id=c.id;
  insert into public.display_calls(candidate_id,table_id,department,display_name,display_code,room_label)
    values (c.id,t.id,t.department,c.full_name,c.code,r.name);
  delete from public.display_calls d where d.department=t.department and d.id not in (
    select id from public.display_calls where department=t.department order by called_at desc,id desc limit 5
  );
end $$;

-- Check-in walk-ins also choose an ngạch when their application is CM or TT.
drop function if exists public.add_walk_in_candidate(text,text,text,text,text,text,text,text,text,text);
create function public.add_walk_in_candidate(
  p_code text, p_full_name text, p_department text,
  p_phone text default null, p_email text default null, p_shift text default null,
  p_student_number text default null, p_student_cohort text default null,
  p_gender text default null, p_facebook_url text default null,
  p_specialization text default null
) returns public.candidates
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  v_candidate public.candidates;
  v_department text := upper(btrim(coalesce(p_department, '')));
  v_specialization text := nullif(upper(btrim(coalesce(p_specialization, ''))), '');
  v_number text := upper(btrim(coalesce(p_student_number, '')));
  v_gender text := upper(btrim(coalesce(p_gender, '')));
begin
  v := public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  if btrim(coalesce(p_code,'')) = '' or length(p_code) > 64 then raise exception 'Mã ứng viên không hợp lệ'; end if;
  if btrim(coalesce(p_full_name,'')) = '' or length(p_full_name) > 200 then raise exception 'Họ tên không hợp lệ'; end if;
  if v_department not in ('CM','VH','TT','ND','HCTC') then raise exception 'Chọn Ban ứng tuyển hợp lệ'; end if;
  if v_department in ('CM','TT') then
    if (v_department='CM' and (v_specialization is null or v_specialization not in ('HAT','NHAC_CU','RAP'))) or
       (v_department='TT' and (v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT'))) then
      raise exception 'Chọn ngạch phù hợp với Ban';
    end if;
  elsif v_specialization is not null then raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông'; end if;
  if v_number !~ '^[A-Z0-9]{8}$' then raise exception 'MSSV phải gồm đúng 8 chữ hoặc số'; end if;
  if v_gender not in ('NAM','NU','KHAC') then raise exception 'Chọn Giới tính hợp lệ'; end if;
  insert into public.candidates
    (code,full_name,student_number,student_cohort,gender,facebook_url,phone,email,department,specialization,shift,status,checked_in_at,
     added_by_id,added_by_name,added_by_email,added_by_role)
  values
    (btrim(p_code),btrim(p_full_name),v_number,nullif(btrim(p_student_cohort),''),v_gender,nullif(btrim(p_facebook_url),''),
     nullif(btrim(p_phone),''),lower(nullif(btrim(p_email),'')),v_department,v_specialization,nullif(btrim(p_shift),''),'CHECKED_IN',now(),
     v.id,coalesce(nullif(v.full_name,''),v.email),v.email,v.role)
  returning * into v_candidate;
  return v_candidate;
end $$;
revoke execute on function public.add_walk_in_candidate(text,text,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.add_walk_in_candidate(text,text,text,text,text,text,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';


-- Run after 20261117_candidate_specializations.sql.
-- Specialization belongs to each desk, so one room can host multiple tracks.

alter table public.tables add column if not exists specialization text;

-- Carry forward the previous room-level setting to its desks before removing it.
do $$ begin
  if exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='rooms' and column_name='specialization') then
    execute 'update public.tables t set specialization = r.specialization from public.rooms r where r.id=t.room_id and t.specialization is null and ((t.department=''CM'' and r.specialization in (''HAT'',''NHAC_CU'',''RAP'')) or (t.department=''TT'' and r.specialization in (''MEDIA'',''DESIGN'',''CONTENT'')))';
  end if;
end $$;

alter table public.tables drop constraint if exists tables_specialization_check;
alter table public.tables add constraint tables_specialization_check check (
  specialization is null or
  (department='CM' and specialization in ('HAT','NHAC_CU','RAP')) or
  (department='TT' and specialization in ('MEDIA','DESIGN','CONTENT'))
);
-- The previous room trigger includes `UPDATE OF specialization`; remove it
-- before dropping that column, then recreate it with per-table validation.
drop trigger if exists rooms_validate_activation on public.rooms;
alter table public.rooms drop constraint if exists rooms_specialization_check;
alter table public.rooms drop column if exists specialization;
create index if not exists tables_department_specialization_idx on public.tables(department,specialization);

create or replace function public.validate_room_activation() returns trigger
language plpgsql set search_path = public as $$
declare
  v_department text;
  v_department_count integer;
begin
  if new.external_challenge and new.is_challenge then
    raise exception 'Chọn một chế độ thử thách cho phòng';
  end if;
  if new.is_configured then
    if new.building_code is null or new.room_number is null then
      raise exception 'Chọn Tòa và Số phòng trước khi kích hoạt';
    end if;
    if (select count(*) from public.tables where room_id=new.id) not between 1 and 4 then
      raise exception 'Phòng phải có từ 1 đến 4 bàn';
    end if;
    if exists (select 1 from public.tables t where t.room_id=new.id and
      (t.department is null or not exists (
        select 1 from public.profiles p where p.table_id=t.id and p.role='INTERVIEWER'
      ))) then
      raise exception 'Mỗi bàn cần Ban và Giám khảo trước khi kích hoạt';
    end if;
    if exists (select 1 from public.tables t where t.room_id=new.id and (
      (t.department='CM' and (t.specialization is null or t.specialization not in ('HAT','NHAC_CU','RAP'))) or
      (t.department='TT' and (t.specialization is null or t.specialization not in ('MEDIA','DESIGN','CONTENT'))) or
      (t.department not in ('CM','TT') and t.specialization is not null)
    )) then
      raise exception 'Mỗi bàn cần chọn ngạch đúng Ban Chuyên Môn/Truyền Thông';
    end if;

    select min(department), count(distinct department)
      into v_department,v_department_count from public.tables where room_id=new.id;
    if new.is_challenge or new.external_challenge then
      if v_department_count<>1 then raise exception 'Mỗi phòng thử thách chỉ cấu hình cho một Ban'; end if;
      if new.is_challenge and v_department<>'HCTC' then raise exception 'Phòng Debate chỉ dành cho Ban HCTC'; end if;
      if new.external_challenge and v_department<>'VH' then raise exception 'Thử thách ngoài phòng chỉ dành cho Ban Văn hóa'; end if;
      if new.is_challenge then
        perform pg_advisory_xact_lock(hashtext('challenge_room:HCTC'));
        if exists (select 1 from public.rooms other where other.id<>new.id and other.is_configured and other.is_challenge) then
          raise exception 'Ban HCTC chỉ được có một phòng Debate đang kích hoạt';
        end if;
      end if;
    end if;
    if exists (select 1 from public.tables t where t.room_id=new.id and t.is_paused) and
      (new.is_challenge or new.external_challenge) then
      raise exception 'Mở lại tiếp nhận ở mọi bàn trước khi kích hoạt chế độ Debate/thử thách';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_validate_activation on public.rooms;
create trigger rooms_validate_activation
  before insert or update of is_configured,is_challenge,external_challenge on public.rooms
  for each row execute function public.validate_room_activation();

create or replace function public.assign_candidate(p_candidate_id uuid,p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  r public.rooms;
begin
  perform public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);
  select * into t from public.tables where id=p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status<>'AVAILABLE' then raise exception 'Bàn này đang bận'; end if;
  if t.is_paused then raise exception 'Bàn đang tạm dừng tiếp nhận thí sinh'; end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.status<>'CHECKED_IN' or c.challenge_status is not null then raise exception 'Thí sinh không ở hàng chờ phỏng vấn thường'; end if;
  select * into r from public.rooms where id=t.room_id;
  if not coalesce(r.is_configured,false) then raise exception 'Phòng chưa được kích hoạt'; end if;
  if coalesce(r.is_challenge,false) then raise exception 'Điều phối không thể gán thí sinh vào phòng thử thách'; end if;
  if t.department is null then raise exception 'Bàn chưa được cấu hình Ban'; end if;
  if c.department is distinct from t.department then raise exception 'Ban của thí sinh không khớp Ban phụ trách bàn'; end if;
  if t.department in ('CM','TT') then
    if c.specialization is null then raise exception 'Admin cần gán ngạch cho thí sinh trước khi điều phối'; end if;
    if t.specialization is distinct from c.specialization then raise exception 'Ngạch của thí sinh không khớp ngạch phụ trách bàn'; end if;
  elsif c.specialization is not null or t.specialization is not null then
    raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông';
  end if;
  if not exists(select 1 from public.profiles p where p.table_id=t.id and p.role='INTERVIEWER') then
    raise exception 'Bàn chưa có tài khoản đại diện';
  end if;
  update public.tables set status='ASSIGNED',current_candidate_id=c.id,assigned_at=now(),started_at=null where id=t.id;
  update public.candidates set status='ASSIGNED',table_id=t.id,assigned_at=now() where id=c.id;
  perform pg_advisory_xact_lock(hashtext('display_calls:'||t.department));
  delete from public.display_calls where candidate_id=c.id;
  insert into public.display_calls(candidate_id,table_id,department,display_name,display_code,room_label)
    values(c.id,t.id,t.department,c.full_name,c.code,r.name);
  delete from public.display_calls d where d.department=t.department and d.id not in (
    select id from public.display_calls where department=t.department order by called_at desc,id desc limit 5
  );
end $$;

notify pgrst,'reload schema';

-- Interview days and per-department schedule migration
-- Run after 20261118_table_specializations.sql on existing projects.
-- One candidate application and evaluation per department; each application has one Ca.
-- Existing completed interviews, evaluations, room and desk settings are preserved.

create or replace function public._upsert_candidate_schedule(p_root_id uuid, p_department text, p_shift text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_root public.candidates;
  v_application_id uuid;
begin
  select * into v_root from public.candidates where id = p_root_id and source_candidate_id is null for update;
  if not found then raise exception 'Không tìm thấy hồ sơ thí sinh gốc'; end if;
  if v_root.department = p_department then
    update public.candidates set shift = p_shift where id = v_root.id;
    return;
  end if;

  select id into v_application_id from public.candidates
    where source_candidate_id = v_root.id and department = p_department for update;
  if v_application_id is null then
    insert into public.candidates
      (code, full_name, student_cohort, gender, facebook_url, phone, email,
       department, shift, cv_url, source_candidate_id, status)
    values
      (public._next_candidate_code(), v_root.full_name, v_root.student_cohort, v_root.gender,
       v_root.facebook_url, v_root.phone, v_root.email, p_department, p_shift,
       v_root.cv_url, v_root.id, 'NOT_ARRIVED');
  else
    update public.candidates set shift = p_shift where id = v_application_id;
  end if;
end $$;
revoke execute on function public._upsert_candidate_schedule(uuid, text, text) from public, anon, authenticated;

-- Repair schedules previously stored as "day (Ban) · day (Ban)" in one row.
-- A second Ban gets its own application; no interview status or score is copied.
do $$
declare
  v_candidate record;
  v_part text;
  v_department text;
  v_root_id uuid;
begin
  for v_candidate in select id, source_candidate_id, shift from public.candidates
    where shift ~ '\([A-Z]+\)' order by created_at, id loop
    v_root_id := coalesce(v_candidate.source_candidate_id, v_candidate.id);
    foreach v_part in array string_to_array(v_candidate.shift, ' · ') loop
      v_part := btrim(v_part);
      v_department := (regexp_match(v_part, '\((CM|VH|TT|ND|HCTC)\)$'))[1];
      if v_department is not null and v_part ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' then
        perform public._upsert_candidate_schedule(v_root_id, v_department, v_part);
      end if;
    end loop;
  end loop;
  update public.candidates c set shift = null
    where c.shift like '% · %' or
      (c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
        and (regexp_match(c.shift, '\(([A-Z]+)\)$'))[1] is distinct from c.department);
end $$;

create or replace function public.import_candidate_schedules(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_number text;
  v_email text;
  v_department text;
  v_root_id uuid;
  v_matches integer;
  v_count integer := 0;
  v_seen jsonb := '{}'::jsonb;
  v_key text;
  v_shift text;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Lịch phải có từ 1 đến 5000 dòng';
  end if;
  for v_row in select * from jsonb_to_recordset(p_rows) as x(student_number text, email text, shift text) loop
    v_count := v_count + 1;
    v_number := upper(btrim(coalesce(v_row.student_number, '')));
    v_email := lower(btrim(coalesce(v_row.email, '')));
    v_shift := btrim(coalesce(v_row.shift, ''));
    v_department := (regexp_match(v_shift, '\((CM|VH|TT|ND|HCTC)\)$'))[1];
    if v_department is null or v_shift !~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' or length(v_shift) > 120 then
      raise exception 'Ca không hợp lệ ở dòng %', v_count;
    end if;
    perform make_date(substring(v_shift, 7, 4)::int, substring(v_shift, 4, 2)::int, left(v_shift, 2)::int);
    if substring(v_shift, 12, 2)::int > 23 or substring(v_shift, 15, 2)::int > 59 then
      raise exception 'Giờ phỏng vấn không hợp lệ ở dòng %', v_count;
    end if;
    v_root_id := null;
    v_matches := 0;
    if v_number ~ '^[A-Z0-9]{8}$' then
      select count(*), min(id::text)::uuid into v_matches, v_root_id
        from public.candidates where student_number = v_number and source_candidate_id is null;
    end if;
    if v_matches = 0 and v_email <> '' then
      select count(*), min(id::text)::uuid into v_matches, v_root_id
        from public.candidates where lower(email) = v_email and source_candidate_id is null;
    end if;
    if v_matches <> 1 then raise exception 'Không đối chiếu được thí sinh ở dòng lịch %', v_count; end if;
    v_key := v_root_id::text || ':' || v_department;
    if v_seen ? v_key and v_seen ->> v_key <> v_shift then
      raise exception 'Một thí sinh có nhiều Ca khác nhau cho cùng Ban ở dòng %', v_count;
    end if;
    v_seen := jsonb_set(v_seen, array[v_key], to_jsonb(v_shift), true);
  end loop;
  for v_key, v_shift in select key, value from jsonb_each_text(v_seen) loop
    perform public._upsert_candidate_schedule(split_part(v_key, ':', 1)::uuid, split_part(v_key, ':', 2), v_shift);
  end loop;
  return v_count;
end $$;

-- Undo legacy automatic check-ins that happened before a later scheduled day.
-- Never touch an assigned desk, an interview, or a recorded evaluation.
update public.candidates child set status = 'NOT_ARRIVED', checked_in_at = null
  where child.source_candidate_id is not null and child.status = 'CHECKED_IN'
    and child.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
    and child.checked_in_at < (to_date(left(child.shift, 10), 'DD/MM/YYYY')::timestamp at time zone 'Asia/Ho_Chi_Minh')
    and child.table_id is null and child.challenge_table_id is null
    and not exists (select 1 from public.evaluations e where e.candidate_id = child.id);

create or replace function public.update_candidate_schedules(p_updates jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row record;
  v_candidate public.candidates;
  v_root_id uuid;
  v_date text;
  v_hour integer;
  v_minute integer;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_updates is null or jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) not between 1 and 8 then
    raise exception 'Danh sách Ca không hợp lệ';
  end if;
  for v_row in select * from jsonb_to_recordset(p_updates) as x(id uuid, shift text) loop
    select * into v_candidate from public.candidates where id = v_row.id for update;
    if not found then raise exception 'Không tìm thấy thí sinh'; end if;
    if v_root_id is null then v_root_id := coalesce(v_candidate.source_candidate_id, v_candidate.id); end if;
    if coalesce(v_candidate.source_candidate_id, v_candidate.id) <> v_root_id then
      raise exception 'Các Ca phải thuộc cùng một thí sinh';
    end if;
    if v_row.shift is not null and btrim(v_row.shift) <> '' then
      if v_row.shift !~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' or
        (regexp_match(v_row.shift, '\(([A-Z]+)\)$'))[1] is distinct from v_candidate.department then
        raise exception 'Ca không khớp Ban của thí sinh';
      end if;
      v_date := left(v_row.shift, 10);
      perform make_date(substring(v_date, 7, 4)::int, substring(v_date, 4, 2)::int, left(v_date, 2)::int);
      v_hour := substring(v_row.shift, 12, 2)::int;
      v_minute := substring(v_row.shift, 15, 2)::int;
      if v_hour > 23 or v_minute > 59 then raise exception 'Giờ phỏng vấn không hợp lệ'; end if;
    end if;
    update public.candidates set shift = nullif(btrim(v_row.shift), '') where id = v_candidate.id;
  end loop;
end $$;

revoke execute on function public.update_candidate_schedules(jsonb) from public, anon;
grant execute on function public.update_candidate_schedules(jsonb) to authenticated;

-- A CM interviewer may refer to a second department already imported from the
-- schedule. Reuse that application and its Ca instead of creating a duplicate.
create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text, p_second_department text, p_second_specialization text
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  t public.tables;
  c public.candidates;
  v_child public.candidates;
  v_eval public.evaluations;
  v_specialization text := nullif(upper(btrim(coalesce(p_second_specialization, ''))), '');
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is null then
    if v_specialization is not null then raise exception 'Chưa chọn Ban thứ hai'; end if;
  else
    if p_second_department not in ('VH','TT','ND','HCTC') then raise exception 'Ban thứ hai không hợp lệ'; end if;
    if p_second_department = 'TT' and (v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT')) then
      raise exception 'Chọn ngạch Truyền Thông cho lượt thứ hai';
    end if;
    if p_second_department <> 'TT' and v_specialization is not null then
      raise exception 'Ngạch chỉ áp dụng cho Truyền Thông ở lượt thứ hai';
    end if;
    select * into t from public.tables where id = p_table_id for update;
    if not found or t.department is distinct from 'CM' or t.current_candidate_id is null then
      raise exception 'Chỉ bàn Chuyên Môn được chọn Ban thứ hai';
    end if;
    select * into c from public.candidates where id = t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then
      raise exception 'Chỉ thí sinh Chuyên Môn gốc được phỏng vấn Ban thứ hai';
    end if;
    select * into v_child from public.candidates where source_candidate_id = c.id for update;
    if found and v_child.department is distinct from p_second_department then
      raise exception 'Thí sinh đã có lịch Ban thứ hai: %', v_child.department;
    end if;
    if found and v_child.department = 'TT' and v_child.specialization is not null and
      v_child.specialization is distinct from v_specialization then
      raise exception 'Ngạch Ban thứ hai không khớp lịch đã cấu hình';
    end if;
  end if;

  v_eval := public.submit_evaluation(p_table_id, p_scores, p_comment);
  if p_second_department is not null then
    if v_child.id is null then
      insert into public.candidates
        (code, full_name, student_cohort, gender, facebook_url, phone, email,
         department, specialization, cv_url, source_candidate_id, status, checked_in_at)
      values
        (public._next_candidate_code(), c.full_name, c.student_cohort, c.gender, c.facebook_url,
         c.phone, c.email, p_second_department, v_specialization, c.cv_url, c.id, 'CHECKED_IN', now());
    elsif v_child.department = 'TT' and v_child.specialization is null then
      update public.candidates set specialization = v_specialization where id = v_child.id;
    end if;
  end if;
  return v_eval;
end $$;

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text, p_second_department text default null
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
begin
  return public.submit_evaluation_with_referral(p_table_id, p_scores, p_comment, p_second_department, null);
end $$;

-- Scheduled second applications wait for their own check-in on their own day.
-- Unscheduled referrals created by an interviewer retain their earlier workflow.
create or replace function public.activate_due_followups() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  update public.candidates child set
    status = 'CHECKED_IN', checked_in_at = coalesce(child.checked_in_at, now()), absent_at = null
  where child.source_candidate_id is not null and child.status = 'NOT_ARRIVED'
    and child.shift is null
    and exists (select 1 from public.candidates parent
      where parent.id = child.source_candidate_id and parent.status = 'COMPLETED');
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.import_candidate_schedules(jsonb) from public, anon;
grant execute on function public.import_candidate_schedules(jsonb) to authenticated;
notify pgrst, 'reload schema';

-- Room layouts by interview day
-- Run after 20261119_interview_days.sql.
-- Prepare each day's room/desk layout without changing the currently active day.
-- Desk IDs and interviewer accounts stay stable; evaluations retain their labels.

create table if not exists public.interview_day_state (
  id text primary key default 'main' check (id = 'main'),
  day date not null,
  activated_at timestamptz not null default now()
);
insert into public.interview_day_state(id,day) values ('main',(now() at time zone 'Asia/Ho_Chi_Minh')::date)
  on conflict(id) do nothing;

create table if not exists public.interview_day_plans (
  day date primary key,
  rooms jsonb not null check (jsonb_typeof(rooms) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.interview_day_state enable row level security;
alter table public.interview_day_plans enable row level security;
drop policy if exists interview_day_state_read on public.interview_day_state;
create policy interview_day_state_read on public.interview_day_state for select to authenticated
  using (public.is_staff());
drop policy if exists interview_day_plans_read on public.interview_day_plans;
create policy interview_day_plans_read on public.interview_day_plans for select to authenticated
  using (public.is_admin());
grant select on public.interview_day_state, public.interview_day_plans to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.interview_day_state;
exception when duplicate_object then null; end $$;

create or replace function public._current_interview_room_plan() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'is_configured', r.is_configured, 'is_challenge', r.is_challenge,
    'external_challenge', r.external_challenge, 'sort_order', r.sort_order,
    'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'department', t.department, 'specialization', t.specialization,
      'sort_order', t.sort_order) order by t.sort_order, t.id)
      from public.tables t where t.room_id = r.id), '[]'::jsonb)
  ) order by r.sort_order, r.id), '[]'::jsonb) from public.rooms r
$$;

create or replace function public._validate_interview_room_plan(p_rooms jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_room jsonb;
  v_table jsonb;
  v_room_id uuid;
  v_table_id uuid;
  v_department text;
  v_specialization text;
  v_active boolean;
  v_challenge boolean;
  v_external boolean;
  v_seen_rooms uuid[] := array[]::uuid[];
  v_seen_tables uuid[];
begin
  if p_rooms is null or jsonb_typeof(p_rooms) <> 'array' or
    jsonb_array_length(p_rooms) <> (select count(*) from public.rooms) then
    raise exception 'Lịch phòng phải có đủ mọi phòng hiện có';
  end if;
  for v_room in select value from jsonb_array_elements(p_rooms) loop
    v_room_id := (v_room ->> 'id')::uuid;
    if v_room_id = any(v_seen_rooms) or not exists(select 1 from public.rooms where id=v_room_id) then
      raise exception 'Phòng trong lịch bị trùng hoặc không tồn tại';
    end if;
    v_seen_rooms := array_append(v_seen_rooms,v_room_id);
    v_active := coalesce((v_room ->> 'is_configured')::boolean,false);
    v_challenge := coalesce((v_room ->> 'is_challenge')::boolean,false);
    v_external := coalesce((v_room ->> 'external_challenge')::boolean,false);
    if v_challenge and v_external then raise exception 'Chỉ chọn một chế độ thử thách'; end if;
    if jsonb_typeof(v_room -> 'tables') <> 'array' or
      jsonb_array_length(v_room -> 'tables') <> (select count(*) from public.tables where room_id=v_room_id) then
      raise exception 'Lịch bàn của phòng chưa đầy đủ';
    end if;
    if v_active and jsonb_array_length(v_room -> 'tables') not between 1 and 4 then
      raise exception 'Phòng hoạt động phải có từ 1 đến 4 bàn';
    end if;
    v_seen_tables := array[]::uuid[];
    for v_table in select value from jsonb_array_elements(v_room -> 'tables') loop
      v_table_id := (v_table ->> 'id')::uuid;
      if v_table_id = any(v_seen_tables) or not exists(
        select 1 from public.tables where id=v_table_id and room_id=v_room_id) then
        raise exception 'Bàn trong lịch bị trùng hoặc không thuộc phòng';
      end if;
      v_seen_tables := array_append(v_seen_tables,v_table_id);
      v_department := nullif(v_table ->> 'department','');
      v_specialization := nullif(v_table ->> 'specialization','');
      if v_active then
        if v_department not in ('CM','VH','TT','ND','HCTC') or v_department is null then
          raise exception 'Mỗi bàn hoạt động phải chọn Ban';
        end if;
        if (v_department='CM' and v_specialization not in ('HAT','NHAC_CU','RAP')) or
          (v_department='TT' and v_specialization not in ('MEDIA','DESIGN','CONTENT')) or
          (v_department not in ('CM','TT') and v_specialization is not null) or
          (v_department in ('CM','TT') and v_specialization is null) then
          raise exception 'Ngạch của bàn không khớp Ban';
        end if;
        if not exists(select 1 from public.profiles where table_id=v_table_id and role='INTERVIEWER') then
          raise exception 'Mỗi bàn hoạt động cần tài khoản Giám khảo đại diện';
        end if;
        if v_challenge and v_department <> 'HCTC' then raise exception 'Phòng Debate chỉ dành cho HCTC'; end if;
        if v_external and v_department <> 'VH' then raise exception 'Thử thách ngoài phòng chỉ dành cho VH'; end if;
      end if;
    end loop;
  end loop;
  if (select count(*) from jsonb_array_elements(p_rooms) r
      where coalesce((r.value ->> 'is_configured')::boolean,false)
        and coalesce((r.value ->> 'is_challenge')::boolean,false)) > 1 then
    raise exception 'Chỉ một phòng Debate HCTC được hoạt động mỗi ngày';
  end if;
end $$;

create or replace function public.save_interview_day_plan(p_day date,p_rooms jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_active_day date;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  select day into v_active_day from public.interview_day_state where id='main' for update;
  if p_day is null or p_day <= v_active_day then raise exception 'Chỉ lập lịch cho ngày sau ngày đang hoạt động'; end if;
  perform public._validate_interview_room_plan(p_rooms);
  insert into public.interview_day_plans(day,rooms) values(p_day,p_rooms)
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();
end $$;

create or replace function public.activate_interview_day(p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_state public.interview_day_state;
  v_plan jsonb;
  v_room jsonb;
  v_table jsonb;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  select * into v_state from public.interview_day_state where id='main' for update;
  if p_day is null or p_day <= v_state.day or p_day <> (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Chỉ kích hoạt ngày phỏng vấn hiện tại sau ngày đang hoạt động';
  end if;
  select rooms into v_plan from public.interview_day_plans where day=p_day;
  if v_plan is null then raise exception 'Chưa lưu bố trí phòng cho ngày này'; end if;
  perform 1 from public.tables for update;
  if exists(select 1 from public.tables where status <> 'AVAILABLE') then
    raise exception 'Cần hoàn tất mọi ca đang ở bàn trước khi đổi ngày';
  end if;
  if exists(select 1 from public.candidates where status in ('ASSIGNED','INTERVIEWING')
      or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING')) then
    raise exception 'Cần hoàn tất các lượt phỏng vấn và thử thách đang chờ trước khi đổi ngày';
  end if;
  perform public._validate_interview_room_plan(v_plan);
  if exists(select 1 from jsonb_array_elements(v_plan) r
    cross join lateral jsonb_array_elements(r.value -> 'tables') j
    join public.tables t on t.id=(j.value ->> 'id')::uuid
    where coalesce((r.value ->> 'is_configured')::boolean,false)
      and (coalesce((r.value ->> 'is_challenge')::boolean,false) or coalesce((r.value ->> 'external_challenge')::boolean,false))
      and t.is_paused) then
    raise exception 'Mở tiếp nhận ở bàn trước khi kích hoạt chế độ thử thách';
  end if;
  insert into public.interview_day_plans(day,rooms) values(v_state.day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();
  update public.rooms set is_configured=false;
  for v_room in select value from jsonb_array_elements(v_plan) loop
    for v_table in select value from jsonb_array_elements(v_room -> 'tables') loop
      update public.tables set department=nullif(v_table ->> 'department',''),
        specialization=nullif(v_table ->> 'specialization',''),
        sort_order=(v_table ->> 'sort_order')::int
        where id=(v_table ->> 'id')::uuid;
    end loop;
  end loop;
  for v_room in select value from jsonb_array_elements(v_plan) loop
    update public.rooms set
      sort_order=(v_room ->> 'sort_order')::int,
      is_challenge=coalesce((v_room ->> 'is_configured')::boolean,false) and coalesce((v_room ->> 'is_challenge')::boolean,false),
      external_challenge=coalesce((v_room ->> 'is_configured')::boolean,false) and coalesce((v_room ->> 'external_challenge')::boolean,false),
      is_configured=coalesce((v_room ->> 'is_configured')::boolean,false)
    where id=(v_room ->> 'id')::uuid;
  end loop;
  update public.interview_day_state set day=p_day,activated_at=now() where id='main';
end $$;

insert into public.interview_day_plans(day,rooms)
  select day,public._current_interview_room_plan() from public.interview_day_state where id='main'
  on conflict(day) do nothing;

-- A scheduled application may only be sent to a desk on its own day.
create or replace function public.enforce_assignment_day() returns trigger
language plpgsql set search_path = public as $$
declare v_shift text; v_day date;
begin
  if new.status='ASSIGNED' and (tg_op='INSERT' or old.status is distinct from 'ASSIGNED') then
    select day into v_day from public.interview_day_state where id='main';
    if v_day is distinct from (now() at time zone 'Asia/Ho_Chi_Minh')::date then
      raise exception 'Cần kích hoạt bố trí phòng cho ngày hôm nay trước khi điều phối';
    end if;
    select shift into v_shift from public.candidates where id=new.current_candidate_id;
    if v_shift ~ '^\d{2}/\d{2}/\d{4} ' and
      to_date(left(v_shift,10),'DD/MM/YYYY') is distinct from v_day then
      raise exception 'Ca của thí sinh không thuộc ngày phỏng vấn đang hoạt động';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tables_enforce_assignment_day on public.tables;
create trigger tables_enforce_assignment_day before insert or update of status,current_candidate_id on public.tables
  for each row execute function public.enforce_assignment_day();

revoke execute on function public._current_interview_room_plan() from public,anon,authenticated;
revoke execute on function public._validate_interview_room_plan(jsonb) from public,anon,authenticated;
revoke execute on function public.save_interview_day_plan(date,jsonb) from public,anon;
revoke execute on function public.activate_interview_day(date) from public,anon;
grant execute on function public.save_interview_day_plan(date,jsonb) to authenticated;
grant execute on function public.activate_interview_day(date) to authenticated;
notify pgrst,'reload schema';

-- Schedule change requests and follow-up scheduling
-- Run after 20261120_interview_day_rooms.sql.
-- Requests keep the old schedule until Admin/Support IT approves.
-- All day/time checks use the database clock in Asia/Ho_Chi_Minh.

create table if not exists public.event_interview_days (
  day date primary key
);
insert into public.event_interview_days(day) values
  ('2026-11-09'),('2026-11-10'),('2026-11-11') on conflict do nothing;

create table if not exists public.schedule_requests (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  kind text not null check(kind in ('RESCHEDULE','FOLLOWUP_UNDECIDED')),
  current_shift text,
  proposed_shift text,
  reason text not null default '' check(length(reason) <= 2000),
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED','RESOLVED')),
  requested_by uuid references public.profiles(id) on delete set null,
  requested_role public.user_role,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text not null default '' check(length(review_note) <= 2000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index if not exists schedule_requests_one_pending_idx
  on public.schedule_requests(candidate_id,kind) where status='PENDING';
create index if not exists schedule_requests_status_time_idx
  on public.schedule_requests(status,created_at desc);

alter table public.event_interview_days enable row level security;
alter table public.schedule_requests enable row level security;
drop policy if exists event_interview_days_read on public.event_interview_days;
create policy event_interview_days_read on public.event_interview_days for select to authenticated using(public.is_staff());
drop policy if exists schedule_requests_read on public.schedule_requests;
create policy schedule_requests_read on public.schedule_requests for select to authenticated using(
  public.is_admin() or public.current_user_role()='COORDINATOR' or requested_by=auth.uid());
grant select on public.event_interview_days,public.schedule_requests to authenticated;

create or replace function public._validate_event_shift(p_shift text,p_department text) returns date
language plpgsql security definer set search_path=public as $$
declare
  v_match text[];
  v_day date;
  v_slot timestamp;
begin
  v_match:=regexp_match(coalesce(p_shift,''),'^(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2}) \((CM|VH|TT|ND|HCTC)\)$');
  if v_match is null or v_match[6] is distinct from p_department then
    raise exception 'Ca không đúng định dạng hoặc không khớp Ban';
  end if;
  v_day:=make_date(v_match[3]::int,v_match[2]::int,v_match[1]::int);
  if v_match[4]::int>23 or v_match[5]::int>59 then raise exception 'Giờ phỏng vấn không hợp lệ'; end if;
  if not exists(select 1 from public.event_interview_days where day=v_day) then
    raise exception 'Chỉ chọn ngày phỏng vấn 09, 10 hoặc 11/11/2026';
  end if;
  v_slot:=make_timestamp(v_match[3]::int,v_match[2]::int,v_match[1]::int,v_match[4]::int,v_match[5]::int,0);
  if v_slot<=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh') then
    raise exception 'Không thể chọn ngày hoặc giờ phỏng vấn đã qua (giờ Hà Nội)';
  end if;
  return v_day;
end $$;

-- A person with an appointment on another day must change that appointment
-- before Check-in can move the application into today's queue.
create or replace function public.check_in_candidate(p_candidate_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  select * into v_candidate from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_candidate.status not in ('NOT_ARRIVED','ABSENT') then
    raise exception 'Thí sinh đã được check-in trước đó';
  end if;
  if v_candidate.shift ~ '^\d{2}/\d{2}/\d{4} ' and
    to_date(left(v_candidate.shift,10),'DD/MM/YYYY') is distinct from v_today then
    raise exception 'Ca không thuộc ngày hôm nay. Gửi yêu cầu đổi lịch trước khi check-in';
  end if;
  update public.candidates set status='CHECKED_IN',checked_in_at=now(),absent_at=null
    where id=p_candidate_id;
end $$;
revoke execute on function public._validate_event_shift(text,text) from public,anon,authenticated;

-- Unscheduled second applications must be given a Ca before assignment.
-- Keep the day guard from migration 20 for every other application.
create or replace function public.enforce_assignment_day() returns trigger
language plpgsql set search_path=public as $$
declare
  v_shift text;
  v_source uuid;
  v_day date;
begin
  if new.status='ASSIGNED' and (tg_op='INSERT' or old.status is distinct from 'ASSIGNED') then
    select day into v_day from public.interview_day_state where id='main';
    if v_day is distinct from (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
      raise exception 'Cần kích hoạt bố trí phòng cho ngày hôm nay trước khi điều phối';
    end if;
    select shift,source_candidate_id into v_shift,v_source from public.candidates where id=new.current_candidate_id;
    if v_source is not null and v_shift is null then
      raise exception 'Lượt Ban thứ hai chưa có Ca. Điều phối cần xếp lịch trước';
    end if;
    if v_shift ~ '^\d{2}/\d{2}/\d{4} ' and
      to_date(left(v_shift,10),'DD/MM/YYYY') is distinct from v_day then
      raise exception 'Ca của thí sinh không thuộc ngày phỏng vấn đang hoạt động';
    end if;
  end if;
  return new;
end $$;

create or replace function public.request_schedule_change(p_candidate_id uuid,p_proposed_shift text,p_reason text)
returns public.schedule_requests
language plpgsql security definer set search_path=public as $$
declare
  v_user public.profiles;
  v_candidate public.candidates;
  v_request public.schedule_requests;
begin
  v_user:=public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  select * into v_candidate from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_candidate.status in ('ASSIGNED','INTERVIEWING','COMPLETED') or v_candidate.challenge_status is not null then
    raise exception 'Chỉ xin đổi lịch cho lượt chưa vào bàn hoặc đang vắng';
  end if;
  perform public._validate_event_shift(p_proposed_shift,v_candidate.department);
  if v_candidate.shift is not distinct from p_proposed_shift then raise exception 'Ca đề xuất trùng Ca hiện tại'; end if;
  insert into public.schedule_requests(candidate_id,kind,current_shift,proposed_shift,reason,requested_by,requested_role)
    values(v_candidate.id,'RESCHEDULE',v_candidate.shift,p_proposed_shift,left(btrim(coalesce(p_reason,'')),2000),v_user.id,v_user.role)
    returning * into v_request;
  return v_request;
end $$;

create or replace function public.decide_schedule_request(p_request_id uuid,p_approve boolean,p_note text)
returns public.schedule_requests
language plpgsql security definer set search_path=public as $$
declare
  v_user public.profiles;
  v_request public.schedule_requests;
  v_candidate public.candidates;
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  v_user:=public._require_role(array['ADMIN']::public.user_role[]);
  select * into v_request from public.schedule_requests where id=p_request_id for update;
  if not found or v_request.kind<>'RESCHEDULE' or v_request.status<>'PENDING' then
    raise exception 'Yêu cầu không còn chờ duyệt';
  end if;
  select * into v_candidate from public.candidates where id=v_request.candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if p_approve then
    if v_candidate.status in ('ASSIGNED','INTERVIEWING','COMPLETED') or v_candidate.challenge_status is not null then
      raise exception 'Thí sinh đã vào bàn hoặc hoàn thành; không thể đổi Ca';
    end if;
    if v_candidate.shift is distinct from v_request.current_shift then
      raise exception 'Ca hiện tại đã thay đổi. Từ chối yêu cầu cũ và gửi yêu cầu mới';
    end if;
    v_day:=public._validate_event_shift(v_request.proposed_shift,v_candidate.department);
    update public.candidates set shift=v_request.proposed_shift,
      status=case when v_day>v_today or status='ABSENT' then 'NOT_ARRIVED'::public.candidate_status else status end,
      checked_in_at=case when v_day>v_today or status='ABSENT' then null else checked_in_at end,
      absent_at=null
      where id=v_candidate.id;
  end if;
  update public.schedule_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,
    reviewed_by=v_user.id,reviewed_at=now(),review_note=left(btrim(coalesce(p_note,'')),2000)
    where id=p_request_id returning * into v_request;
  return v_request;
end $$;

create or replace function public.set_followup_schedule(p_candidate_id uuid,p_shift text)
returns public.candidates
language plpgsql security definer set search_path=public as $$
declare
  v_child public.candidates;
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);
  select * into v_child from public.candidates where id=p_candidate_id for update;
  if not found or v_child.source_candidate_id is null or v_child.status not in ('NOT_ARRIVED','CHECKED_IN') or v_child.challenge_status is not null then
    raise exception 'Lượt Ban thứ hai không còn ở trạng thái chờ';
  end if;
  if not exists(select 1 from public.candidates p where p.id=v_child.source_candidate_id and p.department='CM' and p.status='COMPLETED') then
    raise exception 'Lượt Chuyên môn trước chưa hoàn thành';
  end if;
  v_day:=public._validate_event_shift(p_shift,v_child.department);
  update public.candidates set shift=p_shift,
    status=case when v_day>v_today then 'NOT_ARRIVED'::public.candidate_status else status end,
    checked_in_at=case when v_day>v_today then null else checked_in_at end
    where id=v_child.id returning * into v_child;
  update public.schedule_requests set status='RESOLVED',reviewed_at=now()
    where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  return v_child;
end $$;

-- Six-argument entry point keeps evaluation and follow-up schedule atomic.
create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid,p_scores jsonb,p_comment text,p_second_department text,
  p_second_specialization text,p_second_shift text
) returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  v_user public.profiles;
  v_candidate_id uuid;
  v_child public.candidates;
  v_eval public.evaluations;
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  v_user:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is null and p_second_shift is not null then raise exception 'Chưa chọn Ban thứ hai'; end if;
  if p_second_shift is not null then perform public._validate_event_shift(p_second_shift,p_second_department); end if;
  select current_candidate_id into v_candidate_id from public.tables where id=p_table_id;
  v_eval:=public.submit_evaluation_with_referral(p_table_id,p_scores,p_comment,p_second_department,p_second_specialization);
  if p_second_department is null then return v_eval; end if;
  select * into v_child from public.candidates where source_candidate_id=v_candidate_id and department=p_second_department for update;
  if not found then raise exception 'Không tìm thấy lượt phỏng vấn Ban thứ hai'; end if;
  if p_second_shift is not null then
    v_day:=public._validate_event_shift(p_second_shift,v_child.department);
    if v_child.status not in ('NOT_ARRIVED','CHECKED_IN') then raise exception 'Lượt Ban thứ hai đã vào bàn'; end if;
    update public.candidates set shift=p_second_shift,
      status=case when v_day>v_today then 'NOT_ARRIVED'::public.candidate_status
        when v_child.shift is null then 'CHECKED_IN'::public.candidate_status else status end,
      checked_in_at=case when v_day>v_today then null
        when v_child.shift is null then coalesce(checked_in_at,now()) else checked_in_at end
      where id=v_child.id;
    update public.schedule_requests set status='RESOLVED',reviewed_at=now()
      where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  elsif v_child.shift is null then
    insert into public.schedule_requests(candidate_id,kind,reason,requested_by,requested_role)
      values(v_child.id,'FOLLOWUP_UNDECIDED','Giám khảo Chuyên môn chưa chốt Ca Ban thứ hai',v_user.id,v_user.role)
      on conflict(candidate_id,kind) where status='PENDING' do nothing;
  elsif v_child.status='NOT_ARRIVED' and
    to_date(left(v_child.shift,10),'DD/MM/YYYY')=v_today then
    -- The candidate has just finished CM and is physically present. Reuse the
    -- imported second application and keep it in today's coordinator queue.
    update public.candidates set status='CHECKED_IN',checked_in_at=now() where id=v_child.id;
  end if;
  return v_eval;
end $$;

revoke execute on function public.request_schedule_change(uuid,text,text) from public,anon;
revoke execute on function public.decide_schedule_request(uuid,boolean,text) from public,anon;
revoke execute on function public.set_followup_schedule(uuid,text) from public,anon;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) from public,anon;
grant execute on function public.request_schedule_change(uuid,text,text) to authenticated;
grant execute on function public.decide_schedule_request(uuid,boolean,text) to authenticated;
grant execute on function public.set_followup_schedule(uuid,text) to authenticated;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.schedule_requests;
exception when duplicate_object then null; end $$;
notify pgrst,'reload schema';

-- Automatic interview-day rollover and past-day configuration lock
-- Run after 20261121_schedule_requests.sql.
-- Past interview days become immutable; the saved layout for today's date is
-- applied automatically on the first staff request after Hanoi midnight.

create or replace function public._guard_interview_day_configuration() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_active_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select day into v_active_day from public.interview_day_state where id='main';
  if v_active_day is distinct from v_today or not exists(
    select 1 from public.event_interview_days where day=v_today
  ) then
    raise exception 'Bố trí ngày đã khóa. Chỉ được chỉnh phòng và bàn trong ngày phỏng vấn hiện tại';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists rooms_guard_interview_day_configuration on public.rooms;
create trigger rooms_guard_interview_day_configuration
  before insert or update or delete on public.rooms
  for each row execute function public._guard_interview_day_configuration();

drop trigger if exists tables_guard_interview_day_configuration on public.tables;
create trigger tables_guard_interview_day_configuration
  before insert or delete or update of room_id,name,department,specialization,sort_order,is_paused on public.tables
  for each row execute function public._guard_interview_day_configuration();

create or replace function public._apply_interview_day(p_day date) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_state public.interview_day_state;
  v_plan jsonb;
  v_room jsonb;
  v_table jsonb;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  select * into v_state from public.interview_day_state where id='main' for update;
  if p_day is null or p_day<>v_today or p_day<=v_state.day or
    not exists(select 1 from public.event_interview_days where day=p_day) then
    raise exception 'Chỉ chuyển sang ngày phỏng vấn hiện tại theo giờ Hà Nội';
  end if;
  select rooms into v_plan from public.interview_day_plans where day=p_day;
  if v_plan is null then raise exception 'Chưa lưu bố trí phòng cho ngày %',p_day; end if;

  perform 1 from public.tables for update;
  if exists(select 1 from public.tables where status<>'AVAILABLE') then
    raise exception 'Cần hoàn tất mọi ca đang ở bàn trước khi tự chuyển ngày';
  end if;
  if exists(select 1 from public.candidates where status in ('ASSIGNED','INTERVIEWING')
      or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING')) then
    raise exception 'Cần hoàn tất các lượt phỏng vấn và thử thách đang chờ trước khi tự chuyển ngày';
  end if;
  perform public._validate_interview_room_plan(v_plan);
  if exists(select 1 from jsonb_array_elements(v_plan) r
    cross join lateral jsonb_array_elements(r.value->'tables') j
    join public.tables t on t.id=(j.value->>'id')::uuid
    where coalesce((r.value->>'is_configured')::boolean,false)
      and (coalesce((r.value->>'is_challenge')::boolean,false) or coalesce((r.value->>'external_challenge')::boolean,false))
      and t.is_paused) then
    raise exception 'Mở tiếp nhận ở các bàn thử thách trước khi chuyển ngày';
  end if;

  insert into public.interview_day_plans(day,rooms)
    values(v_state.day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();

  -- Set the day inside this transaction before the configuration triggers run.
  -- No other session can observe a partially applied room plan.
  update public.interview_day_state set day=p_day,activated_at=now() where id='main';
  update public.rooms set is_configured=false;
  for v_room in select value from jsonb_array_elements(v_plan) loop
    for v_table in select value from jsonb_array_elements(v_room->'tables') loop
      update public.tables set department=nullif(v_table->>'department',''),
        specialization=nullif(v_table->>'specialization',''),
        sort_order=(v_table->>'sort_order')::int,
        is_paused=false
        where id=(v_table->>'id')::uuid;
    end loop;
  end loop;
  for v_room in select value from jsonb_array_elements(v_plan) loop
    update public.rooms set sort_order=(v_room->>'sort_order')::int,
      is_challenge=coalesce((v_room->>'is_configured')::boolean,false) and coalesce((v_room->>'is_challenge')::boolean,false),
      external_challenge=coalesce((v_room->>'is_configured')::boolean,false) and coalesce((v_room->>'external_challenge')::boolean,false),
      is_configured=coalesce((v_room->>'is_configured')::boolean,false)
      where id=(v_room->>'id')::uuid;
  end loop;
end $$;

create or replace function public.ensure_interview_day() returns date
language plpgsql security definer set search_path=public as $$
declare
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_active_day date;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  select day into v_active_day from public.interview_day_state where id='main' for update;
  if exists(select 1 from public.event_interview_days where day=v_today) and v_active_day<v_today then
    perform public._apply_interview_day(v_today);
    return v_today;
  end if;
  return v_active_day;
end $$;

create or replace function public.activate_interview_day(p_day date) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  perform public._apply_interview_day(p_day);
end $$;

create or replace function public.save_interview_day_plan(p_day date,p_rooms jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_active_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  select day into v_active_day from public.interview_day_state where id='main' for update;
  if p_day is null or p_day<v_today or p_day<=v_active_day or
    not exists(select 1 from public.event_interview_days where day=p_day) then
    raise exception 'Chỉ được lập lịch cho ngày phỏng vấn sắp tới chưa bị khóa';
  end if;
  perform public._validate_interview_room_plan(p_rooms);
  insert into public.interview_day_plans(day,rooms) values(p_day,p_rooms)
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();
end $$;

revoke execute on function public._guard_interview_day_configuration() from public,anon,authenticated;
revoke execute on function public._apply_interview_day(date) from public,anon,authenticated;
revoke execute on function public.ensure_interview_day() from public,anon;
revoke execute on function public.activate_interview_day(date) from public,anon;
revoke execute on function public.save_interview_day_plan(date,jsonb) from public,anon;
grant execute on function public.ensure_interview_day() to authenticated;
grant execute on function public.activate_interview_day(date) to authenticated;
grant execute on function public.save_interview_day_plan(date,jsonb) to authenticated;
notify pgrst,'reload schema';


-- Admin/Support IT force-submit of an active interview
-- Run after 20261122_auto_lock_interview_days.sql.
-- Admin and Support IT can force-submit an active regular or challenge interview.

create or replace function public.admin_force_finish_interview(p_table_id uuid, p_note text)
returns void
language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles;
  v_table public.tables;
  v_candidate public.candidates;
  v_room public.rooms;
  v_criterion record;
  v_scores jsonb:='{}'::jsonb;
  v_sum numeric:=0;
  v_weight numeric:=0;
  v_average numeric;
  v_duration integer;
  v_label text;
  v_comment text;
  v_room_label text;
  v_eval public.evaluations;
  v_has_debate boolean;
begin
  v_actor:=public._require_role(array['ADMIN']::public.user_role[]);
  if nullif(trim(p_note),'') is null or length(trim(p_note))>2000 then
    raise exception 'Nhập ghi chú cưỡng chế kết thúc (tối đa 2000 ký tự)';
  end if;
  v_label:=case when v_actor.role='SUPPORT_IT' then 'Support IT' else 'Admin' end;
  v_comment:=v_label||': '||trim(p_note);

  select * into v_table from public.tables where id=p_table_id for update;
  if not found or v_table.status<>'INTERVIEWING' or v_table.current_candidate_id is null then
    raise exception 'Bàn này không có buổi phỏng vấn đang diễn ra';
  end if;
  select * into v_candidate from public.candidates where id=v_table.current_candidate_id for update;
  select * into v_room from public.rooms where id=v_table.room_id;
  if v_candidate.id is null then raise exception 'Không tìm thấy thí sinh tại bàn'; end if;

  for v_criterion in select * from public.rubric_criteria where active order by sort_order,created_at loop
    v_scores:=v_scores||jsonb_build_object(v_criterion.id::text,v_criterion.max_score);
    v_sum:=v_sum+10*v_criterion.weight;
    v_weight:=v_weight+v_criterion.weight;
  end loop;
  if v_weight<=0 then raise exception 'Không có tiêu chí chấm đang hoạt động'; end if;
  v_average:=round(v_sum/v_weight,2);
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(v_table.started_at,now())))))::int;
  v_room_label:=coalesce(v_room.name,'')||' - '||v_table.name;

  if coalesce(v_room.is_challenge,false) then
    if v_candidate.challenge_status<>'INTERVIEWING' then
      raise exception 'Thí sinh không ở trạng thái phỏng vấn vòng thử thách';
    end if;
    update public.evaluations set
      challenge_scores=v_scores,
      challenge_average_score=v_average,
      challenge_comment=left(v_comment,5000),
      challenge_interviewer_id=v_actor.id,
      challenge_interviewer_name=coalesce(nullif(v_actor.full_name,''),v_actor.email),
      challenge_table_label=v_room_label,
      challenge_started_at=v_table.started_at,
      challenge_ended_at=now(),
      challenge_duration_seconds=v_duration
    where candidate_id=v_candidate.id returning * into v_eval;
    if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
    update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now()
      where id=v_candidate.id;
  else
    if v_candidate.status<>'INTERVIEWING' or v_candidate.challenge_status is not null then
      raise exception 'Thí sinh không ở trạng thái phỏng vấn vòng thường';
    end if;
    insert into public.evaluations as e
      (candidate_id,table_id,interviewer_id,interviewer_name,table_label,scores,average_score,comment,started_at,ended_at,duration_seconds)
    values
      (v_candidate.id,v_table.id,v_actor.id,coalesce(nullif(v_actor.full_name,''),v_actor.email),v_room_label,
       v_scores,v_average,left(v_comment,5000),v_table.started_at,now(),v_duration)
    on conflict(candidate_id) do update set
      table_id=excluded.table_id,interviewer_id=excluded.interviewer_id,interviewer_name=excluded.interviewer_name,
      table_label=excluded.table_label,scores=excluded.scores,average_score=excluded.average_score,
      comment=excluded.comment,started_at=excluded.started_at,ended_at=excluded.ended_at,
      duration_seconds=excluded.duration_seconds,created_at=now()
    returning * into v_eval;

    if v_candidate.department='HCTC' then
      select exists(select 1 from public.rooms rr join public.tables tt on tt.room_id=rr.id
        where rr.is_configured and rr.is_challenge and tt.department='HCTC') into v_has_debate;
      if not v_has_debate then raise exception 'Admin cần kích hoạt phòng Debate HCTC trước khi nộp'; end if;
    end if;

    if v_candidate.department='HCTC' and v_has_debate then
      update public.candidates set status='CHECKED_IN',challenge_status='WAITING',challenge_table_id=null,
        interview_ended_at=now(),duration_seconds=v_duration where id=v_candidate.id;
    elsif v_candidate.department='VH' and coalesce(v_room.external_challenge,false) then
      update public.candidates set status='CHECKED_IN',challenge_status='WAITING',challenge_table_id=null,
        interview_ended_at=now(),duration_seconds=v_duration where id=v_candidate.id;
    else
      update public.candidates set status='COMPLETED',interview_ended_at=now(),duration_seconds=v_duration
        where id=v_candidate.id;
    end if;
  end if;

  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,started_at=null
    where id=v_table.id;
end $$;

revoke execute on function public.admin_force_finish_interview(uuid,text) from public,anon;
grant execute on function public.admin_force_finish_interview(uuid,text) to authenticated;
notify pgrst,'reload schema';



-- Admin preview access to interviewer desk RPCs
-- Run after 20261123_admin_force_finish.sql.
-- Admin and Support IT may use the interviewer board against a selected desk.

create or replace function public.assign_challenge_candidate(p_candidate_id uuid,p_table_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles;
  t public.tables;
  c public.candidates;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'AVAILABLE' then raise exception 'Bàn Debate chưa sẵn sàng'; end if;
  if not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge) or t.department<>'HCTC' then
    raise exception 'Tài khoản này không thuộc phòng Debate HCTC' using errcode='42501';
  end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_status<>'WAITING' or c.status<>'CHECKED_IN' then
    raise exception 'Thí sinh không còn trong hàng chờ Debate';
  end if;
  if c.department<>'HCTC' then raise exception 'Phòng Debate chỉ nhận thí sinh HCTC'; end if;
  update public.tables set status='ASSIGNED',current_candidate_id=c.id,assigned_at=now(),started_at=null where id=t.id;
  update public.candidates set status='ASSIGNED',challenge_status='ASSIGNED',challenge_table_id=t.id,assigned_at=now() where id=c.id;
end $$;

create or replace function public.submit_challenge_evaluation(p_table_id uuid,p_scores jsonb,p_comment text)
returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_sum numeric:=0; v_wsum numeric:=0; v_clean jsonb:='{}'::jsonb; v_avg numeric; v_dur int;
  v_room text; v_eval public.evaluations;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null then raise exception 'Bàn thử thách chưa có ca đang diễn ra'; end if;
  if not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge) then
    raise exception 'Đây không phải phòng thử thách' using errcode='42501';
  end if;
  select * into c from public.candidates where id=t.current_candidate_id for update;
  if c.challenge_status<>'INTERVIEWING' or c.department is distinct from t.department then raise exception 'Thí sinh không ở đúng vòng thử thách'; end if;
  if p_scores is null or jsonb_typeof(p_scores)<>'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"',r.name; end if;
    begin v_score:=(p_scores->>r.id::text)::numeric; exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"',r.name; end;
    if v_score is null or v_score<0 or v_score>r.max_score then raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %',r.name,r.max_score; end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,v_score);
    v_sum:=v_sum+(v_score/r.max_score)*10*r.weight;
    v_wsum:=v_wsum+r.weight;
  end loop;
  v_avg:=case when v_wsum>0 then round(v_sum/v_wsum,2) end;
  v_dur:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  update public.evaluations set
    challenge_scores=v_clean,challenge_average_score=v_avg,challenge_comment=left(nullif(trim(p_comment),''),5000),
    challenge_interviewer_id=v.id,challenge_interviewer_name=coalesce(nullif(v.full_name,''),v.email),
    challenge_table_label=coalesce(v_room,'')||' - '||t.name,challenge_started_at=t.started_at,
    challenge_ended_at=now(),challenge_duration_seconds=v_dur
  where candidate_id=c.id returning * into v_eval;
  if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
  update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now() where id=c.id;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,started_at=null where id=t.id;
  return v_eval;
end $$;

create or replace function public.finish_external_challenge(p_candidate_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles;
  c public.candidates;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.department<>'VH' or c.challenge_status<>'WAITING' or c.status<>'CHECKED_IN' then
    raise exception 'Chỉ xác nhận được thí sinh Văn hóa đang ở vòng thử thách ngoài phòng';
  end if;
  if (v.role='INTERVIEWER' and c.table_id is distinct from v.table_id) or not exists(
    select 1 from public.rooms r join public.tables t on t.room_id=r.id
    where t.id=c.table_id and r.is_configured and r.external_challenge
  ) or not exists(select 1 from public.evaluations e where e.candidate_id=c.id and e.table_id=c.table_id) then
    raise exception 'Bạn không phụ trách vòng 1 của thí sinh này' using errcode='42501';
  end if;
  update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now() where id=c.id;
end $$;

revoke execute on function public.assign_challenge_candidate(uuid,uuid) from public,anon;
revoke execute on function public.submit_challenge_evaluation(uuid,jsonb,text) from public,anon;
revoke execute on function public.finish_external_challenge(uuid) from public,anon;
grant execute on function public.assign_challenge_candidate(uuid,uuid) to authenticated;
grant execute on function public.submit_challenge_evaluation(uuid,jsonb,text) to authenticated;
grant execute on function public.finish_external_challenge(uuid) to authenticated;
notify pgrst,'reload schema';


-- Run after 20261126_reschedule_requires_checkin.sql.
-- Each department remains a separate candidate row. A changed future schedule
-- must return an unchecked application to Check-in instead of leaving it in the
-- coordinator queue from the previous interview day.

-- Keep the second application self-contained, including its student number.
create or replace function public.inherit_candidate_application_info() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_root public.candidates;
begin
  if new.source_candidate_id is null then return new; end if;
  select * into v_root from public.candidates where id=new.source_candidate_id;
  if not found then raise exception 'Không tìm thấy hồ sơ thí sinh gốc'; end if;
  new.student_number:=coalesce(nullif(btrim(new.student_number),''),v_root.student_number);
  new.student_cohort:=coalesce(nullif(btrim(new.student_cohort),''),v_root.student_cohort);
  new.gender:=coalesce(nullif(btrim(new.gender),''),v_root.gender);
  new.facebook_url:=coalesce(nullif(btrim(new.facebook_url),''),v_root.facebook_url);
  new.phone:=coalesce(nullif(btrim(new.phone),''),v_root.phone);
  new.email:=coalesce(nullif(btrim(new.email),''),v_root.email);
  new.cv_url:=coalesce(nullif(btrim(new.cv_url),''),v_root.cv_url);
  return new;
end $$;
drop trigger if exists candidates_inherit_application_info on public.candidates;
create trigger candidates_inherit_application_info before insert on public.candidates
  for each row execute function public.inherit_candidate_application_info();
revoke execute on function public.inherit_candidate_application_info() from public,anon,authenticated;

-- Importing a changed schedule resets stale attendance only when the application
-- has not been assigned, interviewed, or evaluated.
create or replace function public._upsert_candidate_schedule(p_root_id uuid,p_department text,p_shift text)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_root public.candidates;
  v_application_id uuid;
begin
  select * into v_root from public.candidates where id=p_root_id and source_candidate_id is null for update;
  if not found then raise exception 'Không tìm thấy hồ sơ thí sinh gốc'; end if;
  if v_root.department=p_department then
    update public.candidates c set shift=p_shift,
      status=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then 'NOT_ARRIVED'::public.candidate_status else c.status end,
      checked_in_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then null else c.checked_in_at end,
      absent_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then null else c.absent_at end
    where c.id=v_root.id;
    return;
  end if;

  select id into v_application_id from public.candidates
    where source_candidate_id=v_root.id and department=p_department for update;
  if v_application_id is null then
    insert into public.candidates
      (code,full_name,student_number,student_cohort,gender,facebook_url,phone,email,
       department,shift,cv_url,source_candidate_id,status)
    values
      (public._next_candidate_code(),v_root.full_name,v_root.student_number,v_root.student_cohort,
       v_root.gender,v_root.facebook_url,v_root.phone,v_root.email,p_department,p_shift,
       v_root.cv_url,v_root.id,'NOT_ARRIVED');
  else
    update public.candidates c set shift=p_shift,
      status=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then 'NOT_ARRIVED'::public.candidate_status else c.status end,
      checked_in_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then null else c.checked_in_at end,
      absent_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
          and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
          and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
        then null else c.absent_at end
    where c.id=v_application_id;
  end if;
end $$;
revoke execute on function public._upsert_candidate_schedule(uuid,text,text) from public,anon,authenticated;

-- Admin schedule edits follow the same re-check-in rule as approved requests.
create or replace function public.update_candidate_schedules(p_updates jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_row record;
  v_candidate public.candidates;
  v_root_id uuid;
  v_date text;
  v_hour integer;
  v_minute integer;
  v_shift text;
  v_reset boolean;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  if p_updates is null or jsonb_typeof(p_updates)<>'array' or jsonb_array_length(p_updates) not between 1 and 8 then
    raise exception 'Danh sách Ca không hợp lệ';
  end if;
  for v_row in select * from jsonb_to_recordset(p_updates) as x(id uuid,shift text) loop
    select * into v_candidate from public.candidates where id=v_row.id for update;
    if not found then raise exception 'Không tìm thấy thí sinh'; end if;
    if v_root_id is null then v_root_id:=coalesce(v_candidate.source_candidate_id,v_candidate.id); end if;
    if coalesce(v_candidate.source_candidate_id,v_candidate.id)<>v_root_id then
      raise exception 'Các Ca phải thuộc cùng một thí sinh';
    end if;
    v_shift:=nullif(btrim(v_row.shift),'');
    if v_shift is not null then
      if v_shift !~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' or
        (regexp_match(v_shift,'\(([A-Z]+)\)$'))[1] is distinct from v_candidate.department then
        raise exception 'Ca không khớp Ban của thí sinh';
      end if;
      v_date:=left(v_shift,10);
      perform make_date(substring(v_date,7,4)::int,substring(v_date,4,2)::int,left(v_date,2)::int);
      v_hour:=substring(v_shift,12,2)::int;
      v_minute:=substring(v_shift,15,2)::int;
      if v_hour>23 or v_minute>59 then raise exception 'Giờ phỏng vấn không hợp lệ'; end if;
    end if;

    v_reset:=v_candidate.shift is distinct from v_shift
      and v_candidate.status in ('CHECKED_IN','ABSENT')
      and v_candidate.challenge_status is null
      and v_candidate.table_id is null and v_candidate.challenge_table_id is null
      and not exists(select 1 from public.evaluations e where e.candidate_id=v_candidate.id);
    update public.candidates set shift=v_shift,
      status=case when v_reset then 'NOT_ARRIVED'::public.candidate_status else v_candidate.status end,
      checked_in_at=case when v_reset then null else v_candidate.checked_in_at end,
      absent_at=case when v_reset then null else v_candidate.absent_at end
      where id=v_candidate.id;
  end loop;
end $$;
revoke execute on function public.update_candidate_schedules(jsonb) from public,anon;
grant execute on function public.update_candidate_schedules(jsonb) to authenticated;

-- Repair old second applications accidentally left checked in from their first
-- interview day. Preserve rows that have reached a desk or have an evaluation.
update public.candidates child set status='NOT_ARRIVED',checked_in_at=null,absent_at=null
where child.source_candidate_id is not null
  and child.status='CHECKED_IN'
  and child.challenge_status is null
  and child.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
  and (child.checked_in_at is null or child.checked_in_at <
    (to_date(left(child.shift,10),'DD/MM/YYYY')::timestamp at time zone 'Asia/Ho_Chi_Minh'))
  and child.table_id is null and child.challenge_table_id is null
  and not exists(select 1 from public.evaluations e where e.candidate_id=child.id)
  and exists(select 1 from public.candidates parent where parent.id=child.source_candidate_id and parent.status='COMPLETED');

-- Fill missing student numbers on legacy linked applications.
update public.candidates child set student_number=parent.student_number
from public.candidates parent
where child.source_candidate_id=parent.id and child.student_number is null and parent.student_number is not null;

notify pgrst,'reload schema';

-- Keep fresh installs aligned with 20261128_rollover_absent_applications.sql.
create or replace function public.rollover_absent_applications_on_day_change()
returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_next_day date;
begin
  if new.day is not distinct from old.day then return new; end if;

  select min(day) into v_next_day
    from public.event_interview_days
    where day > old.day;

  if v_next_day is null or new.day is distinct from v_next_day then return new; end if;

  update public.candidates c
     set shift = to_char(v_next_day, 'DD/MM/YYYY') || substr(c.shift, 11),
         status = 'NOT_ARRIVED'::public.candidate_status,
         checked_in_at = null,
         absent_at = null
   where c.status = 'ABSENT'
     and c.challenge_status is null
     and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
     and to_date(left(c.shift, 10), 'DD/MM/YYYY') = old.day
     and c.table_id is null
     and c.challenge_table_id is null
     and not exists (
       select 1 from public.evaluations e where e.candidate_id = c.id
     );

  return new;
end $$;

drop trigger if exists interview_day_rollover_absences on public.interview_day_state;
create trigger interview_day_rollover_absences
  after update of day on public.interview_day_state
  for each row execute function public.rollover_absent_applications_on_day_change();
revoke execute on function public.rollover_absent_applications_on_day_change() from public, anon, authenticated;

-- Same-department re-interview support from 20261129.
drop index if exists public.candidates_one_second_interview;
alter table public.candidates drop constraint if exists candidates_student_number_key;
create unique index if not exists candidates_root_student_number_key
  on public.candidates(student_number) where source_candidate_id is null;

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text,
  p_second_department text, p_second_specialization text
) returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  t public.tables;
  c public.candidates;
  v_child public.candidates;
  v_child_found boolean := false;
  v_other_application boolean := false;
  v_has_evaluation boolean := false;
  v_eval public.evaluations;
  v_specialization text := nullif(upper(btrim(coalesce(p_second_specialization,''))), '');
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is null then
    if v_specialization is not null then raise exception 'Chưa chọn Ban thứ hai'; end if;
  else
    if p_second_department not in ('CM','VH','TT','ND','HCTC') then raise exception 'Ban thứ hai không hợp lệ'; end if;
    if p_second_department = 'CM' then
      if v_specialization is null or v_specialization not in ('HAT','NHAC_CU','RAP') then raise exception 'Chọn ngạch Chuyên Môn cho lượt tiếp theo'; end if;
    elsif p_second_department = 'TT' then
      if v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT') then raise exception 'Chọn ngạch Truyền Thông cho lượt thứ hai'; end if;
    elsif v_specialization is not null then
      raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông';
    end if;
    select * into t from public.tables where id=p_table_id for update;
    if not found or t.department is distinct from 'CM' or t.current_candidate_id is null then raise exception 'Chỉ bàn Chuyên Môn được chọn lượt phỏng vấn tiếp theo'; end if;
    select * into c from public.candidates where id=t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then raise exception 'Chỉ hồ sơ Chuyên Môn gốc được chọn lượt phỏng vấn tiếp theo'; end if;
    if p_second_department = 'CM' then
      if c.specialization is null or c.specialization = v_specialization then raise exception 'Lượt Chuyên Môn tiếp theo phải chọn ngạch khác ngạch hiện tại'; end if;
      select * into v_child from public.candidates
        where source_candidate_id=c.id and department='CM' and specialization=v_specialization
        order by created_at,id limit 1 for update;
      v_child_found := found;
      if v_child_found then
        select exists(select 1 from public.evaluations e where e.candidate_id=v_child.id) into v_has_evaluation;
        if v_has_evaluation or v_child.status in ('ASSIGNED','INTERVIEWING','COMPLETED') then raise exception 'Thí sinh đã có lượt Chuyên Môn ở ngạch này'; end if;
      end if;
      select exists(select 1 from public.candidates x where x.source_candidate_id=c.id and (not v_child_found or x.id<>v_child.id)) into v_other_application;
      if v_other_application then raise exception 'Thí sinh đã có một lượt Ban thứ hai được đăng ký'; end if;
    else
      select * into v_child from public.candidates where source_candidate_id=c.id order by created_at,id limit 1 for update;
      v_child_found := found;
      if v_child_found and v_child.department is distinct from p_second_department then raise exception 'Thí sinh đã đăng ký lượt tiếp theo ở Ban %',v_child.department; end if;
      if v_child_found and v_child.department='TT' and v_child.specialization is not null and v_child.specialization is distinct from v_specialization then raise exception 'Ngạch Truyền Thông không khớp lịch đã cấu hình'; end if;
      if v_child_found then
        select exists(select 1 from public.evaluations e where e.candidate_id=v_child.id) into v_has_evaluation;
        if v_has_evaluation or v_child.status in ('ASSIGNED','INTERVIEWING','COMPLETED') then raise exception 'Thí sinh đã hoàn tất lượt phỏng vấn tiếp theo'; end if;
      end if;
    end if;
  end if;
  v_eval := public.submit_evaluation(p_table_id,p_scores,p_comment);
  if p_second_department is not null then
    if not v_child_found then
      insert into public.candidates
        (code,full_name,student_cohort,gender,facebook_url,phone,email,department,specialization,cv_url,source_candidate_id,status,checked_in_at)
      values
        (public._next_candidate_code(),c.full_name,c.student_cohort,c.gender,c.facebook_url,c.phone,c.email,p_second_department,v_specialization,c.cv_url,c.id,'CHECKED_IN',now());
    elsif v_child.department='TT' and v_child.specialization is null then
      update public.candidates set specialization=v_specialization where id=v_child.id;
    end if;
  end if;
  return v_eval;
end $$;

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid,p_scores jsonb,p_comment text,p_second_department text,
  p_second_specialization text,p_second_shift text
) returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  v_user public.profiles;
  v_candidate_id uuid;
  v_child public.candidates;
  v_eval public.evaluations;
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  v_user:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if p_second_department is null and (p_second_shift is not null or p_second_specialization is not null) then raise exception 'Chưa chọn Ban thứ hai'; end if;
  if p_second_shift is not null then perform public._validate_event_shift(p_second_shift,p_second_department); end if;
  select current_candidate_id into v_candidate_id from public.tables where id=p_table_id;
  if v_candidate_id is null then raise exception 'Bàn không có thí sinh đang phỏng vấn'; end if;
  v_eval:=public.submit_evaluation_with_referral(p_table_id,p_scores,p_comment,p_second_department,p_second_specialization);
  if p_second_department is null then return v_eval; end if;
  select * into v_child from public.candidates
    where source_candidate_id=v_candidate_id and department=p_second_department
      and (p_second_department<>'CM' or specialization=nullif(upper(btrim(coalesce(p_second_specialization,''))),''))
    order by created_at,id limit 1 for update;
  if not found then raise exception 'Không tìm thấy hồ sơ lượt phỏng vấn tiếp theo'; end if;
  if p_second_shift is not null then
    v_day:=public._validate_event_shift(p_second_shift,v_child.department);
    update public.candidates set shift=p_second_shift,
      status=case when v_day>v_today then 'NOT_ARRIVED'::public.candidate_status else 'CHECKED_IN'::public.candidate_status end,
      checked_in_at=case when v_day>v_today then null else coalesce(checked_in_at,now()) end,absent_at=null
      where id=v_child.id;
    update public.schedule_requests set status='RESOLVED',reviewed_at=now()
      where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  elsif v_child.shift is null then
    insert into public.schedule_requests(candidate_id,kind,reason,requested_by,requested_role)
      values(v_child.id,'FOLLOWUP_UNDECIDED','Giám khảo Chuyên môn chưa chốt Ca lượt tiếp theo',v_user.id,v_user.role)
      on conflict(candidate_id,kind) where status='PENDING' do nothing;
  elsif v_child.status in ('NOT_ARRIVED','ABSENT') and to_date(left(v_child.shift,10),'DD/MM/YYYY')=v_today then
    update public.candidates set status='CHECKED_IN',checked_in_at=coalesce(checked_in_at,now()),absent_at=null where id=v_child.id;
  end if;
  return v_eval;
end $$;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) from public,anon;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) from public,anon;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) to authenticated;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) to authenticated;

-- Historical absence snapshots from 20261130_absence_day_history.sql.
create table if not exists public.candidate_day_history (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.candidates(id) on delete set null,
  interview_day date not null,
  candidate_code text not null,
  student_number text,
  full_name text not null,
  phone text,
  department text,
  specialization text,
  shift text not null,
  status public.candidate_status not null,
  absent_note text,
  checked_in_at timestamptz,
  absent_at timestamptz,
  recorded_at timestamptz not null default now(),
  constraint candidate_day_history_status_check check (status = 'ABSENT')
);
create unique index if not exists candidate_day_history_candidate_day_idx
  on public.candidate_day_history(candidate_id, interview_day) where candidate_id is not null;
create index if not exists candidate_day_history_day_idx on public.candidate_day_history(interview_day,department);
alter table public.candidate_day_history enable row level security;
drop policy if exists candidate_day_history_select on public.candidate_day_history;
create policy candidate_day_history_select on public.candidate_day_history for select to authenticated
  using (public.is_admin() or public.current_user_role()='COORDINATOR');
revoke all on public.candidate_day_history from public,anon,authenticated;
grant select on public.candidate_day_history to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.candidate_day_history;
exception when duplicate_object then null; end $$;

create or replace function public.rollover_absent_applications_on_day_change()
returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_next_day date;
begin
  if new.day is not distinct from old.day then return new; end if;
  select min(day) into v_next_day from public.event_interview_days where day > old.day;
  if v_next_day is null or new.day is distinct from v_next_day then return new; end if;
  insert into public.candidate_day_history
    (candidate_id,interview_day,candidate_code,student_number,full_name,phone,department,specialization,shift,status,absent_note,checked_in_at,absent_at)
  select c.id,old.day,c.code,c.student_number,c.full_name,c.phone,c.department,c.specialization,c.shift,c.status,c.absent_note,c.checked_in_at,c.absent_at
    from public.candidates c
   where c.status='ABSENT' and c.challenge_status is null
     and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
     and to_date(left(c.shift,10),'DD/MM/YYYY')=old.day
     and c.table_id is null and c.challenge_table_id is null
     and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
  on conflict (candidate_id,interview_day) where candidate_id is not null do nothing;
  update public.candidates c set shift=to_char(v_next_day,'DD/MM/YYYY')||substr(c.shift,11),
    status='NOT_ARRIVED'::public.candidate_status,checked_in_at=null,absent_at=null
   where c.status='ABSENT' and c.challenge_status is null
     and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
     and to_date(left(c.shift,10),'DD/MM/YYYY')=old.day
     and c.table_id is null and c.challenge_table_id is null
     and not exists(select 1 from public.evaluations e where e.candidate_id=c.id);
  return new;
end $$;
drop trigger if exists interview_day_rollover_absences on public.interview_day_state;
create trigger interview_day_rollover_absences after update of day on public.interview_day_state
  for each row execute function public.rollover_absent_applications_on_day_change();
revoke execute on function public.rollover_absent_applications_on_day_change() from public,anon,authenticated;


-- Latest early-check-in and date-specific absence behavior.
-- Run after 20261130_absence_day_history.sql.
-- Early interviews belong to the actual interview day; future applications
-- marked absent during an earlier event day keep a separate absence snapshot.

alter table public.candidates add column if not exists interview_note text;

create or replace function public.check_in_candidate(p_candidate_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_scheduled_day date;
  v_original_day date;
  v_note text;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  select * into v_candidate from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_candidate.status not in ('NOT_ARRIVED','ABSENT') then
    raise exception 'Thí sinh đã được check-in trước đó';
  end if;

  if v_candidate.shift ~ '^\d{2}/\d{2}/\d{4} ' then
    v_scheduled_day := to_date(left(v_candidate.shift,10),'DD/MM/YYYY');
    if v_scheduled_day < v_today then
      raise exception 'Ca đã qua. Hãy cập nhật Ca trước khi check-in';
    elsif v_scheduled_day > v_today then
      if not exists (select 1 from public.event_interview_days where day=v_today)
        or not exists (select 1 from public.event_interview_days where day=v_scheduled_day) then
        raise exception 'Chỉ có thể phỏng vấn sớm giữa các ngày phỏng vấn đã cấu hình';
      end if;
      v_original_day := v_scheduled_day;
      v_note := 'Phỏng vấn sớm ngày '||to_char(v_today,'DD/MM/YYYY')||
        ' (lịch ban đầu: '||to_char(v_original_day,'DD/MM/YYYY')||')';
      update public.candidates set
        shift=to_char(v_today,'DD/MM/YYYY')||substr(shift,11),
        status='CHECKED_IN',checked_in_at=now(),absent_at=null,absent_note=null,
        interview_note=v_note
      where id=p_candidate_id;
      return;
    end if;
  end if;

  update public.candidates set status='CHECKED_IN',checked_in_at=now(),absent_at=null,absent_note=null
    where id=p_candidate_id;
end $$;

create or replace function public.mark_absent_with_note(p_candidate_id uuid,p_note text) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_active_day date;
  v_scheduled_day date;
  v_absent_at timestamptz := now();
  v_note text := left(nullif(trim(p_note),''),2000);
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR']::public.user_role[]);
  select * into v_candidate from public.candidates where id=p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if v_candidate.status not in ('NOT_ARRIVED','CHECKED_IN') then
    raise exception 'Không thể đánh vắng thí sinh đang ở bàn hoặc đã hoàn thành';
  end if;
  select day into v_active_day from public.interview_day_state where id='main';
  v_active_day := coalesce(v_active_day,(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);

  if v_candidate.shift ~ '^\d{2}/\d{2}/\d{4} ' then
    v_scheduled_day := to_date(left(v_candidate.shift,10),'DD/MM/YYYY');
    if v_scheduled_day > v_active_day then
      insert into public.candidate_day_history
        (candidate_id,interview_day,candidate_code,student_number,full_name,phone,
         department,specialization,shift,status,absent_note,checked_in_at,absent_at)
      values
        (v_candidate.id,v_active_day,v_candidate.code,v_candidate.student_number,v_candidate.full_name,
         v_candidate.phone,v_candidate.department,v_candidate.specialization,v_candidate.shift,'ABSENT',
         v_note,v_candidate.checked_in_at,v_absent_at)
      on conflict (candidate_id,interview_day) where candidate_id is not null do update set
        candidate_code=excluded.candidate_code,student_number=excluded.student_number,full_name=excluded.full_name,
        phone=excluded.phone,department=excluded.department,specialization=excluded.specialization,
        shift=excluded.shift,status='ABSENT',absent_note=excluded.absent_note,
        checked_in_at=excluded.checked_in_at,absent_at=excluded.absent_at,recorded_at=now();

      -- This absence belongs to the active earlier day. Leave the scheduled
      -- application untouched for its own later check-in.
      update public.candidates set status='NOT_ARRIVED',checked_in_at=null,absent_at=null,absent_note=null
        where id=p_candidate_id;
      return;
    end if;
  end if;

  update public.candidates set status='ABSENT',absent_at=v_absent_at,absent_note=v_note
    where id=p_candidate_id;
end $$;

revoke execute on function public.check_in_candidate(uuid) from public,anon;
revoke execute on function public.mark_absent_with_note(uuid,text) from public,anon;
grant execute on function public.check_in_candidate(uuid) to authenticated;
grant execute on function public.mark_absent_with_note(uuid,text) to authenticated;

-- Repair prior wrong-day absences (for example a day-10 supplemental round
-- marked absent on day 9). Keep the day-9 record in history and reopen day 10.
insert into public.candidate_day_history
  (candidate_id,interview_day,candidate_code,student_number,full_name,phone,
   department,specialization,shift,status,absent_note,checked_in_at,absent_at)
select c.id,(c.absent_at at time zone 'Asia/Ho_Chi_Minh')::date,c.code,c.student_number,
       c.full_name,c.phone,c.department,c.specialization,c.shift,'ABSENT',c.absent_note,
       c.checked_in_at,c.absent_at
  from public.candidates c
 where c.status='ABSENT' and c.absent_at is not null
   and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
   and (c.absent_at at time zone 'Asia/Ho_Chi_Minh')::date < to_date(left(c.shift,10),'DD/MM/YYYY')
   and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
   and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
on conflict (candidate_id,interview_day) where candidate_id is not null do update set
  candidate_code=excluded.candidate_code,student_number=excluded.student_number,full_name=excluded.full_name,
  phone=excluded.phone,department=excluded.department,specialization=excluded.specialization,
  shift=excluded.shift,status='ABSENT',absent_note=excluded.absent_note,
  checked_in_at=excluded.checked_in_at,absent_at=excluded.absent_at,recorded_at=now();

update public.candidates c set status='NOT_ARRIVED',checked_in_at=null,absent_at=null,absent_note=null
 where c.status='ABSENT' and c.absent_at is not null
   and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
   and (c.absent_at at time zone 'Asia/Ho_Chi_Minh')::date < to_date(left(c.shift,10),'DD/MM/YYYY')
   and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
   and not exists(select 1 from public.evaluations e where e.candidate_id=c.id);

notify pgrst,'reload schema';


-- Run after 20261201_early_checkin_and_absence_day_capture.sql.
-- A completed application belongs to the day its own interview took place.
-- Move legacy early interviews to that day without touching another linked application.

create or replace function public.align_early_interview_day() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_actual_day date;
  v_scheduled_day date;
begin
  select * into v_candidate from public.candidates where id=new.candidate_id for update;
  if not found or v_candidate.shift !~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' then
    return new;
  end if;
  v_actual_day := (coalesce(new.started_at,v_candidate.interview_started_at,
    new.ended_at,v_candidate.interview_ended_at) at time zone 'Asia/Ho_Chi_Minh')::date;
  if v_actual_day is null then return new; end if;
  v_scheduled_day := to_date(left(v_candidate.shift,10),'DD/MM/YYYY');
  if v_actual_day >= v_scheduled_day or
    not exists (select 1 from public.event_interview_days where day=v_actual_day) then
    return new;
  end if;

  update public.candidates set
    shift=to_char(v_actual_day,'DD/MM/YYYY')||substr(v_candidate.shift,11),
    interview_note=coalesce(nullif(btrim(v_candidate.interview_note),''),
      'Phỏng vấn sớm ngày '||to_char(v_actual_day,'DD/MM/YYYY')||
      ' (lịch ban đầu: '||to_char(v_scheduled_day,'DD/MM/YYYY')||')')
  where id=new.candidate_id;
  return new;
end $$;

drop trigger if exists evaluations_align_early_interview_day on public.evaluations;
create trigger evaluations_align_early_interview_day
  after insert or update of started_at,ended_at on public.evaluations
  for each row execute function public.align_early_interview_day();
revoke execute on function public.align_early_interview_day() from public,anon,authenticated;

-- Repair evaluations recorded before the trigger existed. Keep each linked
-- application's own status, evaluation and schedule independent.
with early as (
  select c.id,
    to_date(left(c.shift,10),'DD/MM/YYYY') as scheduled_day,
    (coalesce(e.started_at,c.interview_started_at,e.ended_at,c.interview_ended_at)
      at time zone 'Asia/Ho_Chi_Minh')::date as actual_day
  from public.candidates c
  join public.evaluations e on e.candidate_id=c.id
  where c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
    and (c.status='COMPLETED' or c.challenge_status is not null)
)
update public.candidates c set
  shift=to_char(early.actual_day,'DD/MM/YYYY')||substr(c.shift,11),
  interview_note=coalesce(nullif(btrim(c.interview_note),''),
    'Phỏng vấn sớm ngày '||to_char(early.actual_day,'DD/MM/YYYY')||
    ' (lịch ban đầu: '||to_char(early.scheduled_day,'DD/MM/YYYY')||')')
from early
where c.id=early.id and early.actual_day<early.scheduled_day
  and exists (select 1 from public.event_interview_days where day=early.actual_day);

notify pgrst,'reload schema';


-- Debate judges are provisioned by Admin before the two-desk room is created.
alter table public.profiles add column if not exists is_debate_judge boolean not null default false;
alter table public.profiles add column if not exists debate_judge_position integer
  check (debate_judge_position in (1,2));
alter table public.candidates add column if not exists debate_batch_number integer;
alter table public.candidates add column if not exists debate_request_status text
  check (debate_request_status in ('PENDING','WAITING','SLOT'));
alter table public.candidates add column if not exists debate_requested_from_table_id uuid
  references public.tables(id) on delete set null;
alter table public.candidates add column if not exists debate_slot_number integer
  check (debate_slot_number in (1,2));

create table if not exists public.debate_judge_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  judge_id uuid not null references public.profiles(id) on delete cascade,
  judge_position integer not null check (judge_position in (1,2)),
  scores jsonb not null default '{}'::jsonb,
  comment text not null default '',
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(candidate_id,judge_id)
);
alter table public.debate_judge_reviews add column if not exists judge_position integer;
alter table public.debate_judge_reviews enable row level security;
drop policy if exists debate_judge_reviews_select on public.debate_judge_reviews;
create policy debate_judge_reviews_select on public.debate_judge_reviews for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.profiles p where p.id=auth.uid() and p.role='INTERVIEWER'
      and p.is_debate_judge and p.table_id=debate_judge_reviews.table_id
  ));
grant select on public.debate_judge_reviews to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.debate_judge_reviews;
exception when duplicate_object then null; end $$;

create or replace function public.debate_judge_count(p_table_id uuid) returns integer
language plpgsql stable security definer set search_path=public as $$
declare v public.profiles; v_count integer;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (not v.is_debate_judge or v.table_id is distinct from p_table_id) then
    raise exception 'Bạn không thuộc bàn Debate này' using errcode='42501';
  end if;
  select count(*) into v_count from public.profiles where table_id=p_table_id
    and role='INTERVIEWER' and is_debate_judge;
  return v_count;
end $$;

with ranked as (
  select id, row_number() over (partition by challenge_table_id order by challenge_started_at,id) as position
  from public.candidates where challenge_table_id is not null and debate_batch_number is null
    and department = 'HCTC'
)
update public.candidates c set debate_batch_number = ((ranked.position + 1) / 2)::integer
from ranked where c.id = ranked.id;
update public.candidates set debate_request_status='WAITING'
  where department='HCTC' and challenge_status='WAITING' and debate_request_status is null;

-- Preserve existing Debate desk accounts on upgraded installations.
update public.profiles p set is_debate_judge = true
from public.tables t join public.rooms r on r.id = t.room_id
where p.table_id = t.id and p.role = 'INTERVIEWER' and r.is_challenge;
update public.profiles set debate_judge_position=1
  where role='INTERVIEWER' and is_debate_judge and table_id is not null
    and debate_judge_position is null;
drop index if exists public.profiles_one_interviewer_per_table;
create unique index if not exists profiles_regular_interviewer_one_per_table
  on public.profiles(table_id) where role='INTERVIEWER' and not is_debate_judge and table_id is not null;
create unique index if not exists profiles_debate_judge_one_per_position
  on public.profiles(table_id,debate_judge_position)
  where role='INTERVIEWER' and is_debate_judge and table_id is not null;

create or replace function public.validate_debate_room_accounts() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_configured and new.is_challenge then
    if (select count(*) from public.tables where room_id = new.id) <> 2 then
      raise exception 'Phòng Debate phải có đúng 2 bàn';
    end if;
    if exists (
      select 1 from public.tables t where t.room_id = new.id and
        (t.department <> 'HCTC' or not exists (
          select 1 from public.profiles p where p.table_id = t.id
            and p.role = 'INTERVIEWER' and p.is_debate_judge and p.debate_judge_position=1
        ))
    ) then
      raise exception 'Mỗi bàn Debate cần tài khoản Giám khảo Debate do Admin cấp riêng';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_debate_account_guard on public.rooms;
create trigger rooms_debate_account_guard before insert or update of is_configured,is_challenge
  on public.rooms for each row execute function public.validate_debate_room_accounts();

create or replace function public.validate_interviewer_kind() returns trigger
language plpgsql set search_path = public as $$
declare v_challenge boolean;
begin
  if new.role = 'INTERVIEWER' and new.table_id is not null then
    select r.is_challenge into v_challenge from public.tables t
      join public.rooms r on r.id = t.room_id where t.id = new.table_id;
    if coalesce(v_challenge,false) is distinct from new.is_debate_judge or
      (v_challenge and new.debate_judge_position is null) or
      (not v_challenge and new.debate_judge_position is not null) then
      raise exception 'Loại tài khoản Giám khảo không phù hợp với bàn';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_interviewer_kind_guard on public.profiles;
create trigger profiles_interviewer_kind_guard before insert or update of table_id,role,is_debate_judge
  on public.profiles for each row execute function public.validate_interviewer_kind();

-- The regular judge chooses a destination during the round-one submission.
create or replace function public.submit_evaluation_to_debate(
  p_table_id uuid, p_scores jsonb, p_comment text, p_debate_table_id uuid
) returns public.evaluations
language plpgsql security definer set search_path = public as $$
declare
  v_actor public.profiles;
  v_candidate_id uuid;
  v_eval public.evaluations;
begin
  v_actor := public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v_actor.role = 'INTERVIEWER' and v_actor.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  select current_candidate_id into v_candidate_id from public.tables where id = p_table_id;
  if v_candidate_id is null or not exists (
    select 1 from public.candidates where id = v_candidate_id and department = 'HCTC'
      and challenge_status is null
  ) then raise exception 'Chỉ chọn bàn Debate cho thí sinh HCTC vòng 1'; end if;
  if not exists (
    select 1 from public.tables t join public.rooms r on r.id = t.room_id
    join public.profiles p on p.table_id = t.id and p.role = 'INTERVIEWER' and p.is_debate_judge
    where t.id = p_debate_table_id and t.department = 'HCTC'
      and r.is_configured and r.is_challenge
  ) then raise exception 'Bàn Debate đã chọn chưa sẵn sàng'; end if;
  v_eval := public.submit_evaluation(p_table_id, p_scores, p_comment);
  update public.candidates set challenge_table_id = p_debate_table_id,
    debate_batch_number = null, debate_request_status='PENDING',
    debate_requested_from_table_id=null, debate_slot_number=null
    where id = v_candidate_id and challenge_status = 'WAITING';
  return v_eval;
end $$;

create or replace function public.assign_challenge_candidate(p_candidate_id uuid,p_table_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  raise exception 'Dùng chức năng nhận ca Debate gồm 2 thí sinh';
end $$;

create or replace function public.handle_debate_request(
  p_candidate_id uuid,p_table_id uuid,p_action text
) returns void
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; c public.candidates;
  v_peer uuid; v_batch integer; v_slot integer;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (v.table_id is distinct from p_table_id or not v.is_debate_judge or v.debate_judge_position<>1) then
    raise exception 'Bạn không được phân công ở bàn Debate này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge)
    then raise exception 'Bàn Debate chưa sẵn sàng'; end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.department<>'HCTC' or c.challenge_status<>'WAITING' or c.status<>'CHECKED_IN'
    or c.debate_request_status not in ('PENDING','WAITING') then
    raise exception 'Thí sinh không còn trong danh sách nhận Debate';
  end if;
  if c.debate_request_status='PENDING' and c.challenge_table_id is distinct from t.id then
    raise exception 'Yêu cầu này thuộc bàn Debate khác' using errcode='42501';
  end if;
  if p_action='FORWARD' then
    if c.debate_request_status<>'PENDING' then raise exception 'Chỉ chuyển được yêu cầu đang chờ phản hồi'; end if;
    select id into v_peer from public.tables where room_id=t.room_id and id<>t.id limit 1;
    if v_peer is null then raise exception 'Không tìm thấy bàn Debate còn lại'; end if;
    update public.candidates set challenge_table_id=v_peer,
      debate_requested_from_table_id=t.id,debate_request_status='PENDING' where id=c.id;
  elsif p_action='REJECT' then
    if c.debate_request_status<>'PENDING' or c.debate_requested_from_table_id is null then
      raise exception 'Chỉ từ chối được yêu cầu chuyển từ bàn kia';
    end if;
    update public.candidates set challenge_table_id=c.debate_requested_from_table_id,
      debate_requested_from_table_id=null,debate_request_status='WAITING' where id=c.id;
  elsif p_action='WAIT' then
    if c.debate_request_status<>'PENDING' then raise exception 'Thí sinh đã ở hàng chờ'; end if;
    update public.candidates set debate_request_status='WAITING',
      debate_requested_from_table_id=null where id=c.id;
  elsif p_action='ACCEPT' then
    if t.status='AVAILABLE' then
      select coalesce(max(debate_batch_number),0)+1 into v_batch
        from public.candidates where challenge_table_id=t.id;
      v_slot:=1;
    elsif t.status='ASSIGNED' and t.current_candidate_id is not null then
      select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
      if v_batch is null or (select count(*) from public.candidates
        where challenge_table_id=t.id and debate_batch_number=v_batch and debate_request_status='SLOT')<>1 then
        raise exception 'Ca Debate đã đủ 2 thí sinh';
      end if;
      v_slot:=2;
    else
      raise exception 'Ca Debate đang diễn ra; đẩy thí sinh vào hàng chờ';
    end if;
    update public.candidates set challenge_table_id=t.id,debate_batch_number=v_batch,
      debate_request_status='SLOT',debate_requested_from_table_id=null,
      debate_slot_number=v_slot,status='ASSIGNED',challenge_status='ASSIGNED',assigned_at=now()
      where id=c.id;
    if v_slot=1 then
      update public.tables set status='ASSIGNED',current_candidate_id=c.id,
        assigned_at=now(),started_at=null where id=t.id;
    end if;
  else
    raise exception 'Thao tác Debate không hợp lệ';
  end if;
end $$;

create or replace function public.assign_debate_pair(p_table_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  raise exception 'Giám khảo Debate phải tự chọn từng thí sinh vào bàn';
end $$;

create or replace function public.start_debate_pair(p_table_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; v_batch integer;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (v.table_id is distinct from p_table_id or not v.is_debate_judge or v.debate_judge_position<>1) then
    raise exception 'Bạn không được phân công ở bàn Debate này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'ASSIGNED' or t.current_candidate_id is null then
    raise exception 'Chưa có ca Debate ở bàn này';
  end if;
  select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
  if (select count(*) from public.candidates where challenge_table_id=p_table_id
    and debate_batch_number=v_batch and challenge_status='ASSIGNED'
    and debate_request_status='SLOT' and debate_slot_number in (1,2))<>2 then
    raise exception 'Ca Debate cần đủ 2 thí sinh';
  end if;
  update public.tables set status='INTERVIEWING',started_at=now() where id=t.id;
  update public.candidates set status='INTERVIEWING',challenge_status='INTERVIEWING',
    interview_started_at=now() where challenge_table_id=p_table_id
      and debate_batch_number=v_batch and challenge_status='ASSIGNED';
  delete from public.display_calls where candidate_id in (
    select id from public.candidates where challenge_table_id=p_table_id and debate_batch_number=v_batch
  );
end $$;

create or replace function public.submit_debate_candidate(
  p_table_id uuid,p_candidate_id uuid,p_scores jsonb,p_comment text
) returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_sum numeric:=0; v_wsum numeric:=0; v_clean jsonb:='{}'::jsonb;
  v_avg numeric; v_dur integer; v_room text; v_eval public.evaluations;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (v.table_id is distinct from p_table_id or not v.is_debate_judge) then
    raise exception 'Bạn không được phân công ở bàn Debate này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null then
    raise exception 'Bàn Debate chưa có ca đang diễn ra';
  end if;
  if not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge) then
    raise exception 'Đây không phải phòng Debate';
  end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_table_id is distinct from p_table_id or
    c.debate_batch_number is distinct from (
      select debate_batch_number from public.candidates where id=t.current_candidate_id
    ) or c.challenge_status<>'INTERVIEWING' then
    raise exception 'Thí sinh không thuộc ca Debate đang diễn ra';
  end if;
  if p_scores is null or jsonb_typeof(p_scores)<>'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"',r.name; end if;
    begin v_score:=(p_scores->>r.id::text)::numeric;
      exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"',r.name;
    end;
    if v_score is null or v_score<0 or v_score>r.max_score then
      raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %',r.name,r.max_score;
    end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,v_score);
    v_sum:=v_sum+(v_score/r.max_score)*10*r.weight;
    v_wsum:=v_wsum+r.weight;
  end loop;
  v_avg:=case when v_wsum>0 then round(v_sum/v_wsum,2) end;
  v_dur:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  update public.evaluations set challenge_scores=v_clean,challenge_average_score=v_avg,
    challenge_comment=left(nullif(trim(p_comment),''),5000),
    challenge_interviewer_id=v.id,challenge_interviewer_name=coalesce(nullif(v.full_name,''),v.email),
    challenge_table_label=coalesce(v_room,'')||' - '||t.name,challenge_started_at=t.started_at,
    challenge_ended_at=now(),challenge_duration_seconds=v_dur
    where candidate_id=c.id returning * into v_eval;
  if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
  update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now()
    where id=c.id;
  if not exists(select 1 from public.candidates where challenge_table_id=p_table_id
    and debate_batch_number=c.debate_batch_number and challenge_status<>'COMPLETED') then
    update public.tables set status='AVAILABLE',current_candidate_id=null,
      assigned_at=null,started_at=null where id=t.id;
  end if;
  return v_eval;
end $$;

create or replace function public.confirm_debate_review(
  p_table_id uuid,p_candidate_id uuid,p_scores jsonb,p_comment text
) returns public.debate_judge_reviews
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record; v_score numeric;
  v_clean jsonb:='{}'::jsonb; v_review public.debate_judge_reviews;
begin
  v:=public._require_role(array['INTERVIEWER']::public.user_role[]);
  if not v.is_debate_judge or v.table_id is distinct from p_table_id
    or v.debate_judge_position not in (1,2) then
    raise exception 'Bạn không phải Giám khảo của bàn Debate này' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null then
    raise exception 'Bàn Debate chưa có ca đang diễn ra';
  end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_table_id is distinct from p_table_id or c.challenge_status<>'INTERVIEWING'
    or c.debate_batch_number is distinct from (
      select debate_batch_number from public.candidates where id=t.current_candidate_id
    ) then raise exception 'Thí sinh không thuộc ca Debate đang diễn ra'; end if;
  if p_scores is null or jsonb_typeof(p_scores)<>'object' then raise exception 'Dữ liệu điểm không hợp lệ'; end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    if not (p_scores ? r.id::text) then raise exception 'Chưa chấm tiêu chí "%"',r.name; end if;
    begin v_score:=(p_scores->>r.id::text)::numeric;
      exception when others then raise exception 'Điểm không hợp lệ ở tiêu chí "%"',r.name;
    end;
    if v_score is null or v_score<0 or v_score>r.max_score then
      raise exception 'Điểm tiêu chí "%" phải trong khoảng 0 - %',r.name,r.max_score;
    end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,v_score);
  end loop;
  insert into public.debate_judge_reviews as review(candidate_id,table_id,judge_id,judge_position,scores,comment,confirmed_at,updated_at)
    values(c.id,t.id,v.id,v.debate_judge_position,v_clean,left(trim(coalesce(p_comment,'')),5000),now(),now())
    on conflict(candidate_id,judge_id) do update set scores=excluded.scores,
      comment=excluded.comment,judge_position=excluded.judge_position,
      confirmed_at=now(),updated_at=now()
    returning * into v_review;
  return v_review;
end $$;

create or replace function public.finalize_debate_candidate(p_table_id uuid,p_candidate_id uuid)
returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; c public.candidates; r record;
  v_expected integer; v_confirmed integer; v_score numeric; v_sum numeric:=0;
  v_weight numeric:=0; v_clean jsonb:='{}'::jsonb; v_avg numeric;
  v_comment text; v_room text; v_duration integer; v_eval public.evaluations;
begin
  v:=public._require_role(array['INTERVIEWER']::public.user_role[]);
  if not v.is_debate_judge or v.table_id is distinct from p_table_id
    or v.debate_judge_position<>1 then
    raise exception 'Chỉ Giám khảo Debate 1 được gửi kết quả cuối' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null then
    raise exception 'Bàn Debate chưa có ca đang diễn ra';
  end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_table_id is distinct from p_table_id or c.challenge_status<>'INTERVIEWING'
    or c.debate_batch_number is distinct from (
      select debate_batch_number from public.candidates where id=t.current_candidate_id
    ) then raise exception 'Thí sinh không thuộc ca Debate đang diễn ra'; end if;
  select count(*) into v_expected from public.profiles where table_id=t.id
    and role='INTERVIEWER' and is_debate_judge;
  select count(*) into v_confirmed from public.debate_judge_reviews d
    join public.profiles p on p.id=d.judge_id and p.table_id=t.id and p.is_debate_judge
    where d.candidate_id=c.id and d.table_id=t.id and d.confirmed_at is not null;
  if v_expected not between 1 and 2 or v_confirmed<>v_expected then
    raise exception 'Cần tất cả Giám khảo tại bàn xác nhận đánh giá trước khi chốt';
  end if;
  for r in select * from public.rubric_criteria where active order by sort_order,created_at loop
    select avg((d.scores->>r.id::text)::numeric) into v_score
      from public.debate_judge_reviews d join public.profiles p on p.id=d.judge_id
      where d.candidate_id=c.id and d.table_id=t.id and p.table_id=t.id and p.is_debate_judge;
    if v_score is null then raise exception 'Giám khảo chưa chấm tiêu chí "%"',r.name; end if;
    v_clean:=v_clean||jsonb_build_object(r.id::text,round(v_score,2));
    v_sum:=v_sum+(v_score/r.max_score)*10*r.weight;
    v_weight:=v_weight+r.weight;
  end loop;
  v_avg:=case when v_weight>0 then round(v_sum/v_weight,2) end;
  select string_agg('Giám khảo '||p.debate_judge_position||': '||
    coalesce(nullif(d.comment,''),'Không có nhận xét'),E'\n\n' order by p.debate_judge_position)
    into v_comment from public.debate_judge_reviews d
    join public.profiles p on p.id=d.judge_id where d.candidate_id=c.id and d.table_id=t.id
      and p.table_id=t.id and p.is_debate_judge;
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  update public.evaluations set challenge_scores=v_clean,challenge_average_score=v_avg,
    challenge_comment=left(v_comment,5000),challenge_interviewer_id=v.id,
    challenge_interviewer_name=coalesce(nullif(v.full_name,''),v.email),
    challenge_table_label=coalesce(v_room,'')||' - '||t.name,
    challenge_started_at=t.started_at,challenge_ended_at=now(),challenge_duration_seconds=v_duration
    where candidate_id=c.id returning * into v_eval;
  if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
  update public.candidates set status='COMPLETED',challenge_status='COMPLETED',interview_ended_at=now()
    where id=c.id;
  if not exists(select 1 from public.candidates where challenge_table_id=t.id
    and debate_batch_number=c.debate_batch_number and challenge_status<>'COMPLETED') then
    update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,
      started_at=null where id=t.id;
  end if;
  return v_eval;
end $$;

create or replace function public.admin_force_finish_debate_pair(p_table_id uuid,p_note text)
returns void
language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles; t public.tables; v_batch integer; c public.candidates;
  v_scores jsonb:='{}'::jsonb; v_criterion record; v_duration integer;
  v_room text; v_comment text;
begin
  v_actor:=public._require_role(array['ADMIN']::public.user_role[]);
  if nullif(trim(p_note),'') is null or length(trim(p_note))>2000 then
    raise exception 'Nhập ghi chú cưỡng chế kết thúc (tối đa 2000 ký tự)';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status not in ('ASSIGNED','INTERVIEWING') or t.current_candidate_id is null
    or not exists(select 1 from public.rooms where id=t.room_id and is_challenge) then
    raise exception 'Bàn này không có ca Debate cần kết thúc';
  end if;
  select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
  for v_criterion in select * from public.rubric_criteria where active loop
    v_scores:=v_scores||jsonb_build_object(v_criterion.id::text,v_criterion.max_score);
  end loop;
  if v_scores='{}'::jsonb then raise exception 'Không có tiêu chí chấm đang hoạt động'; end if;
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::int;
  select name into v_room from public.rooms where id=t.room_id;
  v_comment:=case when v_actor.role='SUPPORT_IT' then 'Support IT' else 'Admin' end||': '||trim(p_note);
  for c in select * from public.candidates where challenge_table_id=t.id
    and debate_batch_number=v_batch and challenge_status in ('ASSIGNED','INTERVIEWING') for update loop
    update public.evaluations set challenge_scores=v_scores,challenge_average_score=10,
      challenge_comment=v_comment,challenge_interviewer_id=v_actor.id,
      challenge_interviewer_name=coalesce(nullif(v_actor.full_name,''),v_actor.email),
      challenge_table_label=coalesce(v_room,'')||' - '||t.name,
      challenge_started_at=coalesce(t.started_at,t.assigned_at),challenge_ended_at=now(),
      challenge_duration_seconds=v_duration where candidate_id=c.id;
    if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
    update public.candidates set status='COMPLETED',challenge_status='COMPLETED',
      interview_ended_at=now() where id=c.id;
  end loop;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,
    started_at=null where id=t.id;
end $$;

-- Returning a candidate to the Debate queue must retain the selected desk.
create or replace function public.return_to_queue(p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.profiles; t public.tables; v_challenge boolean; v_batch integer;
begin
  v := public._require_role(array['ADMIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  if v.role = 'INTERVIEWER' and v.table_id is distinct from p_table_id then
    raise exception 'Bạn không được phân công ở bàn này' using errcode = '42501';
  end if;
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  select is_challenge into v_challenge from public.rooms where id = t.room_id;
  if v_challenge and v.role = 'COORDINATOR' then
    raise exception 'Điều phối chỉ được xem thông tin phòng Debate' using errcode = '42501';
  end if;
  if v_challenge and v.role='INTERVIEWER' and v.debate_judge_position<>1 then
    raise exception 'Chỉ Giám khảo Debate 1 được trả ca về hàng chờ' using errcode='42501';
  end if;
  if t.current_candidate_id is not null then
    if v_challenge then
      select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
      if exists(select 1 from public.candidates where challenge_table_id=t.id
        and debate_batch_number=v_batch and challenge_status='COMPLETED') then
        raise exception 'Ca Debate đã chấm một thí sinh; cần hoàn tất thí sinh còn lại';
      end if;
      delete from public.debate_judge_reviews where candidate_id in (
        select id from public.candidates where challenge_table_id=t.id and debate_batch_number=v_batch
      );
      update public.candidates set status = 'CHECKED_IN', challenge_status = 'WAITING',
        debate_request_status='WAITING',debate_batch_number=null,debate_slot_number=null,
        assigned_at = null, interview_started_at = null
       where challenge_table_id = t.id and debate_batch_number = v_batch
         and challenge_status in ('ASSIGNED','INTERVIEWING');
    else
      update public.candidates set status = 'CHECKED_IN', table_id = null,
        assigned_at = null, interview_started_at = null
       where id = t.current_candidate_id and status in ('ASSIGNED','INTERVIEWING')
         and challenge_status is null;
    end if;
    delete from public.display_calls where candidate_id = t.current_candidate_id;
  end if;
  update public.tables set status = 'AVAILABLE', current_candidate_id = null,
    assigned_at = null, started_at = null where id = t.id;
end $$;

create or replace function public.prevent_incomplete_debate_release() returns trigger
language plpgsql set search_path=public as $$
declare v_batch integer;
begin
  if old.status <> 'AVAILABLE' and new.status = 'AVAILABLE' and old.current_candidate_id is not null
    and exists(select 1 from public.rooms where id=old.room_id and is_challenge) then
    select debate_batch_number into v_batch from public.candidates where id=old.current_candidate_id;
    if exists(select 1 from public.candidates where challenge_table_id=old.id
      and debate_batch_number=v_batch and challenge_status in ('ASSIGNED','INTERVIEWING')) then
      raise exception 'Ca Debate còn thí sinh chưa hoàn tất';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tables_prevent_incomplete_debate_release on public.tables;
create trigger tables_prevent_incomplete_debate_release before update of status on public.tables
  for each row execute function public.prevent_incomplete_debate_release();

drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated
  using (
    public.is_admin() or public.current_user_role()='COORDINATOR'
    or interviewer_id=auth.uid()
    or exists (
      select 1 from public.profiles p
      join public.tables own_table on own_table.id=p.table_id
      join public.rooms own_room on own_room.id=own_table.room_id
      join public.candidates c on c.id=evaluations.candidate_id
      left join public.tables target_table on target_table.id=c.challenge_table_id
      where p.id=auth.uid() and p.role='INTERVIEWER' and p.is_debate_judge
        and own_room.is_configured and own_room.is_challenge
        and c.department='HCTC' and c.challenge_status is not null
        and (target_table.room_id=own_room.id or c.debate_request_status='WAITING')
    )
  );

revoke execute on function public.submit_evaluation_to_debate(uuid,jsonb,text,uuid) from public,anon;
grant execute on function public.submit_evaluation_to_debate(uuid,jsonb,text,uuid) to authenticated;
revoke execute on function public.handle_debate_request(uuid,uuid,text) from public,anon;
grant execute on function public.handle_debate_request(uuid,uuid,text) to authenticated;
revoke execute on function public.assign_debate_pair(uuid) from public,anon;
revoke execute on function public.start_debate_pair(uuid) from public,anon;
revoke execute on function public.submit_debate_candidate(uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.assign_debate_pair(uuid) to authenticated;
grant execute on function public.start_debate_pair(uuid) to authenticated;
revoke execute on function public.submit_debate_candidate(uuid,uuid,jsonb,text) from authenticated;
revoke execute on function public.submit_challenge_evaluation(uuid,jsonb,text) from authenticated;
revoke execute on function public.confirm_debate_review(uuid,uuid,jsonb,text) from public,anon;
revoke execute on function public.finalize_debate_candidate(uuid,uuid) from public,anon;
grant execute on function public.confirm_debate_review(uuid,uuid,jsonb,text) to authenticated;
grant execute on function public.finalize_debate_candidate(uuid,uuid) to authenticated;
revoke execute on function public.debate_judge_count(uuid) from public,anon;
grant execute on function public.debate_judge_count(uuid) to authenticated;
revoke execute on function public.admin_force_finish_debate_pair(uuid,text) from public,anon;
grant execute on function public.admin_force_finish_debate_pair(uuid,text) to authenticated;
notify pgrst,'reload schema';
