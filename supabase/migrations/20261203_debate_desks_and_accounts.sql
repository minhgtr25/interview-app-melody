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
