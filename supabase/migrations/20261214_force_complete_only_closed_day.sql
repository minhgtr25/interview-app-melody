-- Force-complete only unfinished candidates assigned to the day being closed.
-- Future-day candidates keep their original status and evaluation state.
drop function if exists public._force_complete_day_candidates(text);
create or replace function public._force_complete_day_candidates(p_cutoff_day date,p_note text) returns integer
language plpgsql security definer set search_path=public as $$
declare
  v_candidate public.candidates;
  v_note text;
  v_room_label text;
  v_challenge_label text;
  v_count integer:=0;
  v_candidate_ids uuid[]:=array[]::uuid[];
begin
  for v_candidate in select * from public.candidates
    where (status<>'COMPLETED' or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING'))
      and shift ~ '^\d{2}/\d{2}/\d{4} '
      and to_date(left(shift,10),'DD/MM/YYYY')<=p_cutoff_day
    order by id for update loop
    v_note:=p_note||' · Trạng thái trước: '||case v_candidate.status
      when 'NOT_ARRIVED' then 'Chưa đến'
      when 'CHECKED_IN' then 'Đã check-in'
      when 'ASSIGNED' then 'Đã vào bàn'
      when 'INTERVIEWING' then 'Đang phỏng vấn'
      when 'ABSENT' then 'Vắng'
      else 'Hoàn thành' end;
    if v_candidate.challenge_status in ('WAITING','ASSIGNED','INTERVIEWING') then
      v_note:=v_note||', thử thách '||v_candidate.challenge_status;
    end if;
    select r.name||' - '||t.name into v_room_label from public.tables t
      join public.rooms r on r.id=t.room_id where t.id=v_candidate.table_id;
    select r.name||' - '||t.name into v_challenge_label from public.tables t
      join public.rooms r on r.id=t.room_id where t.id=v_candidate.challenge_table_id;

    update public.candidates set status='COMPLETED',
      challenge_status=case when v_candidate.challenge_status is null then null else 'COMPLETED' end,
      debate_request_status=null,debate_requested_from_table_id=null,
      interview_note=left(v_note||case when nullif(btrim(coalesce(v_candidate.interview_note,'')),'') is null
        then '' else E'\n'||v_candidate.interview_note end,5000),
      interview_ended_at=now(),
      duration_seconds=case when v_candidate.interview_started_at is not null
        then greatest(0,floor(extract(epoch from(now()-v_candidate.interview_started_at))))::int
        else v_candidate.duration_seconds end
      where id=v_candidate.id;

    insert into public.evaluations as e
      (candidate_id,table_id,table_label,scores,comment,started_at,ended_at,
       challenge_scores,challenge_comment,challenge_table_label,challenge_ended_at)
    values
      (v_candidate.id,v_candidate.table_id,v_room_label,'{}'::jsonb,v_note,
       v_candidate.interview_started_at,
       case when v_candidate.interview_started_at is not null then now() else null end,
       '{}'::jsonb,case when v_candidate.challenge_status is not null then v_note else null end,
       v_challenge_label,case when v_candidate.challenge_status is not null then now() else null end)
    on conflict(candidate_id) do update set
      comment=case when v_candidate.challenge_status is null
        then left(v_note||case when nullif(btrim(coalesce(e.comment,'')),'') is null
          then '' else E'\n'||e.comment end,5000) else e.comment end,
      ended_at=case when v_candidate.challenge_status is null and
        v_candidate.interview_started_at is not null then now() else e.ended_at end,
      challenge_comment=case when v_candidate.challenge_status is not null
        then left(v_note||case when nullif(btrim(coalesce(e.challenge_comment,'')),'') is null
          then '' else E'\n'||e.challenge_comment end,5000) else e.challenge_comment end,
      challenge_table_label=coalesce(e.challenge_table_label,v_challenge_label),
      challenge_ended_at=case when v_candidate.challenge_status is not null
        then now() else e.challenge_ended_at end;
    v_count:=v_count+1;
    v_candidate_ids:=array_append(v_candidate_ids,v_candidate.id);
  end loop;

  update public.schedule_requests set status='RESOLVED',reviewed_at=now(),
    review_note=left(p_note||case when review_note='' then '' else E'\n'||review_note end,2000)
    where status='PENDING' and candidate_id=any(v_candidate_ids);
  update public.tables set status='AVAILABLE',current_candidate_id=null,
    assigned_at=null,started_at=null where archived_at is null
      and (status<>'AVAILABLE' or current_candidate_id is not null);
  delete from public.display_calls where id is not null;
  return v_count;
end $$;

create or replace function public._apply_interview_day(p_day date) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_state public.interview_day_state;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  select * into v_state from public.interview_day_state where id='main' for update;
  if p_day is null or p_day<>v_today or p_day<=v_state.day then
    raise exception 'Chỉ chuyển sang ngày hiện tại theo giờ Hà Nội';
  end if;
  perform 1 from public.tables where archived_at is null for update;
  insert into public.interview_day_plans(day,rooms)
    values(v_state.day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();

  perform public._force_complete_day_candidates(v_state.day,
    'Cưỡng chế kết thúc khi chuyển sang ngày '||to_char(p_day,'DD/MM/YYYY'));
  -- Complete candidates before the day trigger that reschedules absences.
  update public.interview_day_state set day=p_day,activated_at=now() where id='main';
  update public.profiles set table_id=null
    where table_id in (select id from public.tables where archived_at is null);
  update public.tables set archived_at=now(),is_paused=false where archived_at is null;
  update public.rooms set is_configured=false,archived_at=now() where archived_at is null;
  insert into public.interview_day_plans(day,rooms) values(p_day,'[]'::jsonb)
    on conflict(day) do update set rooms='[]'::jsonb,updated_at=now();
end $$;

create or replace function public.reset_today_interview_rooms() returns void
language plpgsql security definer set search_path=public as $$
declare
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  select day into v_day from public.interview_day_state where id='main' for update;
  if v_day is distinct from v_today then
    raise exception 'Chỉ đặt lại cấu hình của ngày hiện tại';
  end if;
  perform 1 from public.tables where archived_at is null for update;
  if not exists(select 1 from public.rooms where archived_at is null) then
    raise exception 'Hôm nay chưa có phòng/bàn để đặt lại';
  end if;
  insert into public.interview_day_plans(day,rooms)
    values(v_day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();
  perform public._force_complete_day_candidates(v_day,
    'Cưỡng chế kết thúc khi đặt lại cấu hình ngày '||to_char(v_day,'DD/MM/YYYY'));
  update public.profiles set table_id=null
    where table_id in (select id from public.tables where archived_at is null);
  update public.tables set archived_at=now(),is_paused=false where archived_at is null;
  update public.rooms set is_configured=false,archived_at=now() where archived_at is null;
end $$;

revoke execute on function public._force_complete_day_candidates(date,text) from public,anon,authenticated;
revoke execute on function public._apply_interview_day(date) from public,anon,authenticated;
revoke execute on function public.reset_today_interview_rooms() from public,anon;
grant execute on function public.reset_today_interview_rooms() to authenticated;
notify pgrst,'reload schema';
