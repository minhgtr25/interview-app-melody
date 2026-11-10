-- A Debate desk may start with slot 1 alone. Slot 2 stays in the queue until another batch.
create or replace function public.start_debate_pair(p_table_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v public.profiles; t public.tables; v_batch integer;
  v_size integer; v_slots integer; v_min_slot integer; v_max_slot integer;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (v.table_id is distinct from p_table_id
    or not v.is_debate_judge or v.debate_judge_position<>1) then
    raise exception 'Chỉ Giám khảo Debate 1 được bắt đầu ca' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'ASSIGNED' or t.current_candidate_id is null or not exists (
    select 1 from public.rooms where id=t.room_id and is_configured and is_challenge
  ) then raise exception 'Chưa có ca Debate ở bàn này'; end if;
  select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
  select count(*),count(distinct debate_slot_number),min(debate_slot_number),max(debate_slot_number)
    into v_size,v_slots,v_min_slot,v_max_slot from public.candidates
    where challenge_table_id=t.id and debate_batch_number=v_batch
      and challenge_status='ASSIGNED' and debate_request_status='SLOT';
  if v_batch is null or v_size not between 1 and 2 or v_slots<>v_size
    or v_min_slot<>1 or v_max_slot<>v_size then
    raise exception 'Ca Debate cần 1 hoặc 2 thí sinh ở đúng vị trí';
  end if;
  update public.tables set status='INTERVIEWING',started_at=now() where id=t.id;
  update public.candidates set status='INTERVIEWING',challenge_status='INTERVIEWING',
    interview_started_at=now() where challenge_table_id=t.id
      and debate_batch_number=v_batch and challenge_status='ASSIGNED';
  delete from public.display_calls where candidate_id in (
    select id from public.candidates where challenge_table_id=t.id and debate_batch_number=v_batch
  );
end $$;

create or replace function public._save_debate_comment(
  p_table_id uuid,p_candidate_id uuid,p_judge_id uuid,p_comment text
) returns public.debate_judge_reviews
language plpgsql security definer set search_path=public as $$
declare
  t public.tables; c public.candidates; j public.profiles;
  v_judges integer; v_size integer; v_review public.debate_judge_reviews;
begin
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null or not exists (
    select 1 from public.rooms where id=t.room_id and is_configured and is_challenge
  ) then raise exception 'Bàn Debate chưa có ca đang diễn ra'; end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.challenge_table_id is distinct from t.id or c.challenge_status<>'INTERVIEWING'
    or c.debate_batch_number is distinct from (
      select debate_batch_number from public.candidates where id=t.current_candidate_id
    ) then raise exception 'Thí sinh không thuộc ca Debate đang diễn ra'; end if;
  select * into j from public.profiles where id=p_judge_id and role='INTERVIEWER'
    and is_debate_judge and table_id=t.id and debate_judge_position in (1,2);
  if not found then raise exception 'Giám khảo không thuộc bàn Debate này' using errcode='42501'; end if;
  select count(*) into v_judges from public.profiles where table_id=t.id
    and role='INTERVIEWER' and is_debate_judge;
  select count(*) into v_size from public.candidates where challenge_table_id=t.id
    and debate_batch_number=c.debate_batch_number and challenge_status='INTERVIEWING';
  if v_judges not between 1 and 2 or v_size not between 1 and 2 then
    raise exception 'Ca Debate hoặc số giám khảo không hợp lệ';
  end if;
  if (v_size=1 and j.debate_judge_position<>1)
    or (v_size=2 and v_judges=2 and j.debate_judge_position is distinct from c.debate_slot_number) then
    raise exception 'Giám khảo này không phụ trách vị trí thí sinh; chỉ được xem phiếu' using errcode='42501';
  end if;
  if nullif(btrim(coalesce(p_comment,'')),'') is null then raise exception 'Nhập nhận xét Debate trước khi xác nhận'; end if;
  insert into public.debate_judge_reviews as review
    (candidate_id,table_id,judge_id,judge_position,scores,comment,confirmed_by_id,confirmed_at,updated_at)
    values(c.id,t.id,j.id,j.debate_judge_position,'{}'::jsonb,left(btrim(p_comment),5000),auth.uid(),now(),now())
    on conflict(candidate_id,judge_id) do update set scores='{}'::jsonb,
      comment=excluded.comment,judge_position=excluded.judge_position,
      confirmed_by_id=auth.uid(),confirmed_at=now(),updated_at=now()
    returning * into v_review;
  return v_review;
end $$;

create or replace function public.finalize_debate_pair(p_table_id uuid,p_judge_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles; t public.tables; c public.candidates; j public.profiles;
  v_judges integer; v_batch integer; v_size integer; v_slots integer;
  v_min_slot integer; v_max_slot integer; v_review public.debate_judge_reviews;
  v_room text; v_duration integer;
begin
  v_actor:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v_actor.role='INTERVIEWER' then
    if v_actor.table_id is distinct from p_table_id or not v_actor.is_debate_judge
      or v_actor.debate_judge_position<>1 or p_judge_id is not null then
      raise exception 'Chỉ Giám khảo Debate 1 được chốt ca' using errcode='42501';
    end if;
  elsif not exists(select 1 from public.profiles where id=p_judge_id and table_id=p_table_id
    and role='INTERVIEWER' and is_debate_judge and debate_judge_position=1) then
    raise exception 'Admin phải mở tài khoản Giám khảo Debate 1 để chốt ca' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status<>'INTERVIEWING' or t.current_candidate_id is null or not exists (
    select 1 from public.rooms where id=t.room_id and is_configured and is_challenge
  ) then raise exception 'Bàn Debate chưa có ca đang diễn ra'; end if;
  select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
  select count(*),count(distinct debate_slot_number),min(debate_slot_number),max(debate_slot_number)
    into v_size,v_slots,v_min_slot,v_max_slot from public.candidates
    where challenge_table_id=t.id and debate_batch_number=v_batch;
  if v_batch is null or v_size not between 1 and 2 or v_slots<>v_size
    or v_min_slot<>1 or v_max_slot<>v_size then
    raise exception 'Ca Debate cần 1 hoặc 2 thí sinh ở đúng vị trí';
  end if;
  select count(*) into v_judges from public.profiles where table_id=t.id
    and role='INTERVIEWER' and is_debate_judge;
  if v_judges not between 1 and 2 then raise exception 'Bàn Debate cần 1 hoặc 2 giám khảo'; end if;
  select name into v_room from public.rooms where id=t.room_id;
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::integer;
  for c in select * from public.candidates where challenge_table_id=t.id
    and debate_batch_number=v_batch order by debate_slot_number for update loop
    if c.challenge_status<>'INTERVIEWING' then raise exception 'Ca Debate có thí sinh chưa bắt đầu'; end if;
    select d.* into v_review from public.debate_judge_reviews d
      join public.profiles p on p.id=d.judge_id
      where d.candidate_id=c.id and d.table_id=t.id and d.confirmed_at is not null
        and p.role='INTERVIEWER' and p.is_debate_judge and p.table_id=t.id
        and p.debate_judge_position=case when v_size=1 or v_judges=1 then 1 else c.debate_slot_number end;
    if not found then raise exception 'Mỗi thí sinh cần được giám khảo phụ trách xác nhận nhận xét'; end if;
    select * into j from public.profiles where id=v_review.judge_id;
    update public.evaluations set challenge_scores='{}'::jsonb,challenge_average_score=null,
      challenge_comment=v_review.comment,challenge_interviewer_id=j.id,
      challenge_interviewer_name=coalesce(nullif(j.full_name,''),j.email),
      challenge_table_label=coalesce(v_room,'')||' - '||t.name,
      challenge_started_at=t.started_at,challenge_ended_at=now(),challenge_duration_seconds=v_duration
      where candidate_id=c.id;
    if not found then raise exception 'Không tìm thấy phiếu phỏng vấn vòng thường'; end if;
    update public.candidates set status='COMPLETED',challenge_status='COMPLETED',
      interview_ended_at=now() where id=c.id;
  end loop;
  update public.tables set status='AVAILABLE',current_candidate_id=null,assigned_at=null,
    started_at=null where id=t.id;
end $$;

revoke execute on function public.start_debate_pair(uuid) from public,anon;
revoke execute on function public.finalize_debate_pair(uuid,uuid) from public,anon;
revoke execute on function public._save_debate_comment(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.start_debate_pair(uuid) to authenticated;
grant execute on function public.finalize_debate_pair(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
