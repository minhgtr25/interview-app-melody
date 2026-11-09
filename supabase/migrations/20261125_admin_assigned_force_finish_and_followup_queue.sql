-- Run after 20261124_admin_desk_preview.sql.
-- Allow Admin/Support IT to close an assigned desk and route second applications
-- to today's coordinator queue or a future day's check-in list.

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
  v_is_challenge boolean;
begin
  v_actor:=public._require_role(array['ADMIN']::public.user_role[]);
  if nullif(trim(p_note),'') is null or length(trim(p_note))>2000 then
    raise exception 'Nhập ghi chú cưỡng chế kết thúc (tối đa 2000 ký tự)';
  end if;
  v_label:=case when v_actor.role='SUPPORT_IT' then 'Support IT' else 'Admin' end;
  v_comment:=v_label||': '||trim(p_note);

  select * into v_table from public.tables where id=p_table_id for update;
  if not found or v_table.status not in ('ASSIGNED','INTERVIEWING') or v_table.current_candidate_id is null then
    raise exception 'Bàn này không có lượt phỏng vấn cần kết thúc';
  end if;
  select * into v_candidate from public.candidates where id=v_table.current_candidate_id for update;
  select * into v_room from public.rooms where id=v_table.room_id;
  if v_candidate.id is null then raise exception 'Không tìm thấy thí sinh tại bàn'; end if;
  v_is_challenge:=coalesce(v_room.is_challenge,false);

  if v_is_challenge then
    if v_candidate.challenge_status is distinct from v_table.status::text then
      raise exception 'Trạng thái thí sinh không khớp với bàn thử thách';
    end if;
  elsif v_candidate.status::text is distinct from v_table.status::text or v_candidate.challenge_status is not null then
    raise exception 'Trạng thái thí sinh không khớp với bàn phỏng vấn';
  end if;

  for v_criterion in select * from public.rubric_criteria where active order by sort_order,created_at loop
    v_scores:=v_scores||jsonb_build_object(v_criterion.id::text,v_criterion.max_score);
    v_sum:=v_sum+10*v_criterion.weight;
    v_weight:=v_weight+v_criterion.weight;
  end loop;
  if v_weight<=0 then raise exception 'Không có tiêu chí chấm đang hoạt động'; end if;
  v_average:=round(v_sum/v_weight,2);
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(v_table.started_at,now())))))::int;
  v_room_label:=coalesce(v_room.name,'')||' - '||v_table.name;

  if v_is_challenge then
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
    status=case when v_day>v_today then 'NOT_ARRIVED'::public.candidate_status else 'CHECKED_IN'::public.candidate_status end,
    checked_in_at=case when v_day>v_today then null else coalesce(checked_in_at,now()) end
    where id=v_child.id returning * into v_child;
  update public.schedule_requests set status='RESOLVED',reviewed_at=now()
    where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  return v_child;
end $$;
revoke execute on function public.set_followup_schedule(uuid,text) from public,anon;
grant execute on function public.set_followup_schedule(uuid,text) to authenticated;

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
        else 'CHECKED_IN'::public.candidate_status end,
      checked_in_at=case when v_day>v_today then null else coalesce(checked_in_at,now()) end
      where id=v_child.id;
    update public.schedule_requests set status='RESOLVED',reviewed_at=now()
      where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  elsif v_child.shift is null then
    insert into public.schedule_requests(candidate_id,kind,reason,requested_by,requested_role)
      values(v_child.id,'FOLLOWUP_UNDECIDED','Giám khảo Chuyên môn chưa chốt Ca Ban thứ hai',v_user.id,v_user.role)
      on conflict(candidate_id,kind) where status='PENDING' do nothing;
  elsif v_child.status='NOT_ARRIVED' and
    to_date(left(v_child.shift,10),'DD/MM/YYYY')=v_today then
    update public.candidates set status='CHECKED_IN',checked_in_at=coalesce(checked_in_at,now()) where id=v_child.id;
  end if;
  return v_eval;
end $$;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) from public,anon;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) to authenticated;

notify pgrst,'reload schema';
