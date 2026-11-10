-- A two-judge Debate desk assigns one candidate to each judge. Debate has comments, not rubric scores.
alter table public.debate_judge_reviews add column if not exists confirmed_by_id uuid references public.profiles(id) on delete set null;
update public.debate_judge_reviews set confirmed_by_id=judge_id where confirmed_by_id is null;

create or replace function public._save_debate_comment(
  p_table_id uuid,p_candidate_id uuid,p_judge_id uuid,p_comment text
) returns public.debate_judge_reviews
language plpgsql security definer set search_path=public as $$
declare
  t public.tables; c public.candidates; j public.profiles;
  v_count integer; v_review public.debate_judge_reviews;
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
  select count(*) into v_count from public.profiles where table_id=t.id
    and role='INTERVIEWER' and is_debate_judge;
  if v_count not between 1 and 2 then raise exception 'Bàn Debate cần 1 hoặc 2 giám khảo'; end if;
  if v_count=2 and j.debate_judge_position is distinct from c.debate_slot_number then
    raise exception 'Mỗi giám khảo chỉ nhận xét thí sinh ở vị trí được phân công' using errcode='42501';
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

create or replace function public.confirm_debate_comment(
  p_table_id uuid,p_candidate_id uuid,p_comment text
) returns public.debate_judge_reviews
language plpgsql security definer set search_path=public as $$
declare v public.profiles;
begin
  v:=public._require_role(array['INTERVIEWER']::public.user_role[]);
  if not v.is_debate_judge or v.table_id is distinct from p_table_id then
    raise exception 'Bạn không thuộc bàn Debate này' using errcode='42501';
  end if;
  return public._save_debate_comment(p_table_id,p_candidate_id,v.id,p_comment);
end $$;

create or replace function public.admin_confirm_debate_comment(
  p_table_id uuid,p_candidate_id uuid,p_judge_id uuid,p_comment text
) returns public.debate_judge_reviews
language plpgsql security definer set search_path=public as $$
begin
  perform public._require_role(array['ADMIN']::public.user_role[]);
  return public._save_debate_comment(p_table_id,p_candidate_id,p_judge_id,p_comment);
end $$;

create or replace function public.finalize_debate_pair(p_table_id uuid,p_judge_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles; t public.tables; c public.candidates; j public.profiles;
  v_count integer; v_batch integer; v_review public.debate_judge_reviews;
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
  if v_batch is null or (select count(*) from public.candidates where challenge_table_id=t.id
      and debate_batch_number=v_batch and debate_slot_number in (1,2))<>2
    or (select count(distinct debate_slot_number) from public.candidates where challenge_table_id=t.id
      and debate_batch_number=v_batch)<>2 then raise exception 'Ca Debate cần đủ 2 thí sinh'; end if;
  select count(*) into v_count from public.profiles where table_id=t.id
    and role='INTERVIEWER' and is_debate_judge;
  if v_count not between 1 and 2 then raise exception 'Bàn Debate cần 1 hoặc 2 giám khảo'; end if;
  select name into v_room from public.rooms where id=t.room_id;
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::integer;
  for c in select * from public.candidates where challenge_table_id=t.id
    and debate_batch_number=v_batch order by debate_slot_number for update loop
    if c.challenge_status='COMPLETED' then continue; end if;
    if c.challenge_status<>'INTERVIEWING' then raise exception 'Ca Debate có thí sinh chưa bắt đầu'; end if;
    select d.* into v_review from public.debate_judge_reviews d
      join public.profiles p on p.id=d.judge_id
      where d.candidate_id=c.id and d.table_id=t.id and d.confirmed_at is not null
        and p.role='INTERVIEWER' and p.is_debate_judge and p.table_id=t.id
        and p.debate_judge_position=case when v_count=2 then c.debate_slot_number else 1 end;
    if not found then raise exception 'Cả hai thí sinh cần được giám khảo phụ trách xác nhận nhận xét'; end if;
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

create or replace function public.route_debate_request(p_candidate_id uuid,p_from_table_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v public.profiles; t public.tables; c public.candidates; v_peer uuid;
begin
  v:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  if v.role='INTERVIEWER' and (v.table_id is distinct from p_from_table_id
    or not v.is_debate_judge or v.debate_judge_position<>1) then
    raise exception 'Chỉ Giám khảo Debate 1 được chuyển yêu cầu' using errcode='42501';
  end if;
  select * into t from public.tables where id=p_from_table_id for update;
  if not found or not exists(select 1 from public.rooms where id=t.room_id and is_configured and is_challenge)
    then raise exception 'Bàn Debate chưa sẵn sàng'; end if;
  select id into v_peer from public.tables where room_id=t.room_id and id<>t.id;
  if v_peer is null then raise exception 'Không tìm thấy bàn Debate còn lại'; end if;
  select * into c from public.candidates where id=p_candidate_id for update;
  if not found or c.department<>'HCTC' or c.challenge_status<>'WAITING'
    or c.status<>'CHECKED_IN' or c.debate_request_status<>'WAITING' then
    raise exception 'Thí sinh không còn ở hàng chờ Debate';
  end if;
  update public.candidates set challenge_table_id=v_peer,
    debate_requested_from_table_id=t.id,debate_request_status='PENDING' where id=c.id;
end $$;

create or replace function public.admin_force_finish_debate_pair(p_table_id uuid,p_note text)
returns void language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles; t public.tables; v_batch integer; c public.candidates;
  v_room text; v_comment text; v_duration integer;
begin
  v_actor:=public._require_role(array['ADMIN']::public.user_role[]);
  if nullif(btrim(p_note),'') is null or length(btrim(p_note))>2000 then
    raise exception 'Nhập ghi chú cưỡng chế kết thúc (tối đa 2000 ký tự)'; end if;
  select * into t from public.tables where id=p_table_id for update;
  if not found or t.status not in ('ASSIGNED','INTERVIEWING') or t.current_candidate_id is null
    or not exists(select 1 from public.rooms where id=t.room_id and is_challenge) then
    raise exception 'Bàn này không có ca Debate cần kết thúc'; end if;
  select debate_batch_number into v_batch from public.candidates where id=t.current_candidate_id;
  select name into v_room from public.rooms where id=t.room_id;
  v_duration:=greatest(0,floor(extract(epoch from(now()-coalesce(t.started_at,now())))))::integer;
  v_comment:='Admin: '||btrim(p_note);
  for c in select * from public.candidates where challenge_table_id=t.id
    and debate_batch_number=v_batch and challenge_status in ('ASSIGNED','INTERVIEWING') for update loop
    update public.evaluations set challenge_scores='{}'::jsonb,challenge_average_score=null,
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

revoke execute on function public._save_debate_comment(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.confirm_debate_review(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke execute on function public.finalize_debate_candidate(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.submit_debate_candidate(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke execute on function public.confirm_debate_comment(uuid,uuid,text) from public,anon;
revoke execute on function public.admin_confirm_debate_comment(uuid,uuid,uuid,text) from public,anon;
revoke execute on function public.finalize_debate_pair(uuid,uuid) from public,anon;
revoke execute on function public.route_debate_request(uuid,uuid) from public,anon;
grant execute on function public.confirm_debate_comment(uuid,uuid,text) to authenticated;
grant execute on function public.admin_confirm_debate_comment(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.finalize_debate_pair(uuid,uuid) to authenticated;
grant execute on function public.route_debate_request(uuid,uuid) to authenticated;

create or replace function public.set_ops_sender_label() returns trigger
language plpgsql security definer set search_path=public as $$
declare v public.profiles;
begin
  select * into v from public.profiles where id=new.sender_id;
  new.sender_label:=case v.role
    when 'ADMIN' then 'Admin'
    when 'SUPPORT_IT' then 'Support IT'
    when 'COORDINATOR' then 'Điều phối'
    when 'INTERVIEWER' then
      case when v.is_debate_judge then 'Giám khảo Debate '||v.debate_judge_position
        else 'Giám khảo phỏng vấn' end||' · '||coalesce(nullif(v.full_name,''),v.email)
    else 'Nhân sự'
  end;
  return new;
end $$;

-- Both Debate desks can join the same judge-to-judge conversation for an HCTC candidate.
drop policy if exists ops_messages_select on public.ops_messages;
create policy ops_messages_select on public.ops_messages for select to authenticated
  using (public.is_admin() or public.current_user_role()='COORDINATOR' or exists (
    select 1 from public.profiles p where p.id=auth.uid() and p.role='INTERVIEWER' and (
      (ops_messages.candidate_id is null and p.table_id=ops_messages.table_id) or
      (ops_messages.candidate_id is not null and exists (
        select 1 from public.candidates c where c.id=ops_messages.candidate_id and (
          p.table_id in (c.table_id,c.challenge_table_id) or
          (p.is_debate_judge and c.department='HCTC' and c.challenge_status is not null and exists (
            select 1 from public.tables own_desk join public.rooms r on r.id=own_desk.room_id
            join public.tables destination on destination.room_id=r.id and destination.id=c.challenge_table_id
            where own_desk.id=p.table_id and r.is_challenge and r.is_configured
          ))
        )
      ))
    )
  ));
drop policy if exists ops_messages_chat_insert on public.ops_messages;
create policy ops_messages_chat_insert on public.ops_messages for insert to authenticated
  with check (kind='CHAT' and sender_id=auth.uid() and (
    public.is_admin() or public.current_user_role()='COORDINATOR' or exists (
      select 1 from public.profiles p where p.id=auth.uid() and p.role='INTERVIEWER'
        and p.table_id=ops_messages.table_id and (
          ops_messages.candidate_id is null or exists (
            select 1 from public.candidates c where c.id=ops_messages.candidate_id and (
              p.table_id in (c.table_id,c.challenge_table_id) or
              (p.is_debate_judge and c.department='HCTC' and c.challenge_status is not null and exists (
                select 1 from public.tables own_desk join public.rooms r on r.id=own_desk.room_id
                join public.tables destination on destination.room_id=r.id and destination.id=c.challenge_table_id
                where own_desk.id=p.table_id and r.is_challenge and r.is_configured
              ))
            )
          )
        )
    )
  ));
notify pgrst,'reload schema';
