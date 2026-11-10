-- Run after 20261129_same_department_specialization_reinterview.sql.
-- Preserve the old day's absence when the live application moves forward.

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
create index if not exists candidate_day_history_day_idx
  on public.candidate_day_history(interview_day, department);

alter table public.candidate_day_history enable row level security;
drop policy if exists candidate_day_history_select on public.candidate_day_history;
create policy candidate_day_history_select on public.candidate_day_history for select to authenticated
  using (public.is_admin() or public.current_user_role() = 'COORDINATOR');
revoke all on public.candidate_day_history from public, anon, authenticated;
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
    (candidate_id,interview_day,candidate_code,student_number,full_name,phone,
     department,specialization,shift,status,absent_note,checked_in_at,absent_at)
  select c.id,old.day,c.code,c.student_number,c.full_name,c.phone,c.department,
         c.specialization,c.shift,c.status,c.absent_note,c.checked_in_at,c.absent_at
    from public.candidates c
   where c.status='ABSENT' and c.challenge_status is null
     and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
     and to_date(left(c.shift,10),'DD/MM/YYYY')=old.day
     and c.table_id is null and c.challenge_table_id is null
     and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
  on conflict (candidate_id,interview_day) where candidate_id is not null do nothing;

  update public.candidates c
     set shift=to_char(v_next_day,'DD/MM/YYYY')||substr(c.shift,11),
         status='NOT_ARRIVED'::public.candidate_status,
         checked_in_at=null,absent_at=null
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
notify pgrst,'reload schema';
