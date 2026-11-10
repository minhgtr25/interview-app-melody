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
