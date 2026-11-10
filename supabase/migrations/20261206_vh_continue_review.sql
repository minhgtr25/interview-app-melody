-- Văn hoá may return from its external challenge to the same interview desk for another review.
create or replace function public.continue_vh_review(p_candidate_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles;
  v_table public.tables;
  v_candidate public.candidates;
begin
  v_actor:=public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);
  select t.* into v_table from public.tables t
    join public.candidates c on c.table_id=t.id
    where c.id=p_candidate_id for update of t;
  if not found then raise exception 'Không tìm thấy bàn phỏng vấn của thí sinh'; end if;
  if v_actor.role='INTERVIEWER' and v_actor.table_id is distinct from v_table.id then
    raise exception 'Bạn không phụ trách thí sinh này' using errcode='42501';
  end if;
  if v_table.status<>'AVAILABLE' then raise exception 'Bàn đang bận; hãy hoàn thành ca hiện tại trước'; end if;
  if not exists(select 1 from public.rooms r where r.id=v_table.room_id
    and r.is_configured and not r.is_challenge and r.external_challenge)
    or v_table.department<>'VH' then
    raise exception 'Chỉ bàn Văn hoá có thử thách ngoài phòng được tiếp tục chấm';
  end if;
  select * into v_candidate from public.candidates where id=p_candidate_id for update;
  if not found or v_candidate.department<>'VH' or v_candidate.table_id is distinct from v_table.id
    or v_candidate.status<>'CHECKED_IN' or v_candidate.challenge_status<>'WAITING'
    or not exists(select 1 from public.evaluations e
      where e.candidate_id=v_candidate.id and e.table_id=v_table.id) then
    raise exception 'Thí sinh không còn ở vòng thử thách Văn hoá để tiếp tục chấm';
  end if;
  update public.candidates set status='ASSIGNED',challenge_status=null,
    challenge_started_at=null,challenge_table_id=null,assigned_at=now(),
    interview_started_at=null,interview_ended_at=null where id=v_candidate.id;
  update public.tables set status='ASSIGNED',current_candidate_id=v_candidate.id,
    assigned_at=now(),started_at=null where id=v_table.id;
end $$;

revoke execute on function public.continue_vh_review(uuid) from public,anon;
grant execute on function public.continue_vh_review(uuid) to authenticated;
notify pgrst,'reload schema';
