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
