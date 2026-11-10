-- Run after 20261127_two_application_day_checkin.sql.
-- Move unresolved absences to the next event day when the room plan activates.
-- Each department application stays independent; completed/evaluated rows remain untouched.

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

  -- Only roll forward one configured event day at a time. A final event day
  -- has no next day, so its absences remain available for explicit handling.
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
notify pgrst, 'reload schema';
