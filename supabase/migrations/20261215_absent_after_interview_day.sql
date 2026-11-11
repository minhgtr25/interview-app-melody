-- An unfinished application is absent when its scheduled interview day closes.
-- The existing interview-day trigger records that absence and advances eligible
-- applications to the next configured event day. On the final day they remain absent.
create or replace function public._force_complete_day_candidates(p_cutoff_day date,p_note text) returns integer
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_note text;
  v_count integer:=0;
  v_candidate_ids uuid[]:=array[]::uuid[];
begin
  for v_candidate in select * from public.candidates
    where (status<>'COMPLETED' or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING'))
      and shift ~ '^\d{2}/\d{2}/\d{4} '
      and to_date(left(shift,10),'DD/MM/YYYY')<=p_cutoff_day
    order by id for update loop
    v_note:=left('Vắng khi kết thúc ngày phỏng vấn '||to_char(p_cutoff_day,'DD/MM/YYYY')||
      ' · Trạng thái trước: '||case v_candidate.status
      when 'NOT_ARRIVED' then 'Chưa đến'
      when 'CHECKED_IN' then 'Đã check-in'
      when 'ASSIGNED' then 'Đã vào bàn'
      when 'INTERVIEWING' then 'Đang phỏng vấn'
      when 'ABSENT' then 'Vắng'
      else 'Đã hoàn thành vòng phỏng vấn' end,2000);

    update public.candidates set status='ABSENT',
      challenge_status=null,challenge_table_id=null,
      debate_request_status=null,debate_requested_from_table_id=null,
      debate_batch_number=null,debate_slot_number=null,
      table_id=null,assigned_at=null,interview_started_at=null,
      challenge_started_at=null,interview_ended_at=null,
      duration_seconds=case when interview_started_at is not null
        then greatest(0,floor(extract(epoch from(now()-interview_started_at))))::int
        else duration_seconds end,
      absent_at=now(),absent_note=v_note
      where id=v_candidate.id;
    v_candidate_ids:=array_append(v_candidate_ids,v_candidate.id);
    v_count:=v_count+1;
  end loop;

  update public.schedule_requests set status='RESOLVED',reviewed_at=now(),
    review_note=left('Hồ sơ chuyển thành Vắng khi kết thúc ngày phỏng vấn '||
      to_char(p_cutoff_day,'DD/MM/YYYY')||case when nullif(btrim(coalesce(review_note,'')),'') is null
      then '' else E'\n'||review_note end,2000)
    where status='PENDING' and candidate_id=any(v_candidate_ids);
  update public.tables set status='AVAILABLE',current_candidate_id=null,
    assigned_at=null,started_at=null where archived_at is null
      and (status<>'AVAILABLE' or current_candidate_id is not null);
  delete from public.display_calls where id is not null;
  return v_count;
end $$;

revoke execute on function public._force_complete_day_candidates(date,text) from public,anon,authenticated;

-- Carry only applications with no actual score into the next configured event day.
-- Record every missed day, including the final one; applications with real scores
-- retain their evaluation and stay ABSENT when their workflow was unfinished.
create or replace function public.rollover_absent_applications_on_day_change()
returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_day date:=old.day;
  v_next_day date;
  v_candidate_ids uuid[];
begin
  if new.day is not distinct from old.day then return new; end if;
  loop
    select coalesce(array_agg(c.id),array[]::uuid[]) into v_candidate_ids
      from public.candidates c
     where c.status in ('ABSENT','NOT_ARRIVED')
       and c.challenge_status is null
       and c.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
       and to_date(left(c.shift,10),'DD/MM/YYYY')=v_day
       and c.table_id is null and c.challenge_table_id is null
       and not exists(select 1 from public.evaluations e where e.candidate_id=c.id
         and (e.average_score is not null or e.challenge_average_score is not null
           or e.scores<>'{}'::jsonb or e.challenge_scores<>'{}'::jsonb));
    if cardinality(v_candidate_ids)=0 then exit; end if;

    insert into public.candidate_day_history
      (candidate_id,interview_day,candidate_code,student_number,full_name,phone,
       department,specialization,shift,status,absent_note,checked_in_at,absent_at)
    select c.id,v_day,c.code,c.student_number,c.full_name,c.phone,c.department,
           c.specialization,c.shift,'ABSENT',
           coalesce(nullif(c.absent_note,''),nullif(e.comment,''),nullif(e.challenge_comment,'')),
           c.checked_in_at,coalesce(c.absent_at,now())
      from public.candidates c left join public.evaluations e on e.candidate_id=c.id
     where c.id=any(v_candidate_ids)
    on conflict (candidate_id,interview_day) where candidate_id is not null do update set
      candidate_code=excluded.candidate_code,student_number=excluded.student_number,
      full_name=excluded.full_name,phone=excluded.phone,department=excluded.department,
      specialization=excluded.specialization,shift=excluded.shift,status='ABSENT',
      absent_note=excluded.absent_note,checked_in_at=excluded.checked_in_at,
      absent_at=excluded.absent_at,recorded_at=now();

    -- Empty or comment-only rows are not completed reviews and would otherwise
    -- make the candidate appear completed or conflict with their next review.
    delete from public.evaluations e where e.candidate_id=any(v_candidate_ids)
      and e.average_score is null and e.challenge_average_score is null
      and e.scores='{}'::jsonb and e.challenge_scores='{}'::jsonb;

    select min(day) into v_next_day from public.event_interview_days
      where day>v_day;
    if v_next_day is null then exit; end if;

    update public.candidates set
      shift=to_char(v_next_day,'DD/MM/YYYY')||substr(shift,11),
      status=case when v_next_day<new.day then 'ABSENT'::public.candidate_status
        else 'NOT_ARRIVED'::public.candidate_status end,
      checked_in_at=null,
      absent_at=case when v_next_day<new.day then now() else null end,
      absent_note=case when v_next_day<new.day
        then 'Vắng trong ngày phỏng vấn '||to_char(v_next_day,'DD/MM/YYYY') else null end
      where id=any(v_candidate_ids);
    if v_next_day>=new.day then exit; end if;
    v_day:=v_next_day;
  end loop;
  return new;
end $$;

drop trigger if exists interview_day_rollover_absences on public.interview_day_state;
create trigger interview_day_rollover_absences after update of day on public.interview_day_state
  for each row execute function public.rollover_absent_applications_on_day_change();
revoke execute on function public.rollover_absent_applications_on_day_change() from public,anon,authenticated;
notify pgrst,'reload schema';
