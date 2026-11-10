-- Run after 20261125_admin_assigned_force_finish_and_followup_queue.sql.
-- An approved schedule change always requires the candidate to check in again,
-- even when the new slot is later on the current interview day.

create or replace function public.decide_schedule_request(p_request_id uuid,p_approve boolean,p_note text)
returns public.schedule_requests
language plpgsql security definer set search_path=public as $$
declare
  v_user public.profiles;
  v_request public.schedule_requests;
  v_candidate public.candidates;
  v_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  v_user:=public._require_role(array['ADMIN']::public.user_role[]);
  select * into v_request from public.schedule_requests where id=p_request_id for update;
  if not found or v_request.kind<>'RESCHEDULE' or v_request.status<>'PENDING' then
    raise exception 'Yêu cầu không còn chờ duyệt';
  end if;
  select * into v_candidate from public.candidates where id=v_request.candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if p_approve then
    if v_candidate.status in ('ASSIGNED','INTERVIEWING','COMPLETED') or v_candidate.challenge_status is not null then
      raise exception 'Thí sinh đã vào bàn hoặc hoàn thành; không thể đổi Ca';
    end if;
    if v_candidate.shift is distinct from v_request.current_shift then
      raise exception 'Ca hiện tại đã thay đổi. Từ chối yêu cầu cũ và gửi yêu cầu mới';
    end if;
    v_day:=public._validate_event_shift(v_request.proposed_shift,v_candidate.department);
    -- Approval is a reschedule, not a check-in. Reset any prior attendance so
    -- the candidate returns to Check-in for the selected date, including a
    -- later slot on today's date.
    update public.candidates set shift=v_request.proposed_shift,
      status='NOT_ARRIVED'::public.candidate_status,
      checked_in_at=null,
      absent_at=null
      where id=v_candidate.id;
  end if;
  update public.schedule_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,
    reviewed_by=v_user.id,reviewed_at=now(),review_note=left(btrim(coalesce(p_note,'')),2000)
    where id=p_request_id returning * into v_request;
  return v_request;
end $$;

revoke execute on function public.decide_schedule_request(uuid,boolean,text) from public,anon;
grant execute on function public.decide_schedule_request(uuid,boolean,text) to authenticated;

notify pgrst,'reload schema';
