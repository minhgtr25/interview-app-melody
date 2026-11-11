-- Restore the guarded rollover behavior from 20261209 after reverting forced completion.
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
  if exists(select 1 from public.tables where archived_at is null and status<>'AVAILABLE') then
    raise exception 'Cần hoàn tất mọi ca đang ở bàn trước khi chuyển ngày';
  end if;
  if exists(select 1 from public.candidates where status in ('ASSIGNED','INTERVIEWING')
      or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING')) then
    raise exception 'Cần hoàn tất các lượt phỏng vấn và thử thách đang chờ trước khi chuyển ngày';
  end if;

  insert into public.interview_day_plans(day,rooms)
    values(v_state.day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();

  -- Change the day first so the room/table configuration guards accept the
  -- archival updates. The entire rollover remains one transaction.
  update public.interview_day_state set day=p_day,activated_at=now() where id='main';
  update public.profiles set table_id=null
    where table_id in (select id from public.tables where archived_at is null);
  update public.tables set archived_at=now(),is_paused=false
    where archived_at is null;
  update public.rooms set is_configured=false,archived_at=now()
    where archived_at is null;
  delete from public.display_calls where id is not null;

  -- A previously saved future layout must not become today's configuration.
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
  if exists(select 1 from public.tables where archived_at is null and status<>'AVAILABLE')
    or exists(select 1 from public.candidates where status in ('ASSIGNED','INTERVIEWING')
      or challenge_status in ('WAITING','ASSIGNED','INTERVIEWING')) then
    raise exception 'Cần hoàn tất mọi ca và thử thách đang chờ trước khi đặt lại bàn';
  end if;
  if not exists(select 1 from public.rooms where archived_at is null) then
    raise exception 'Hôm nay chưa có phòng/bàn để đặt lại';
  end if;
  insert into public.interview_day_plans(day,rooms)
    values(v_day,public._current_interview_room_plan())
    on conflict(day) do update set rooms=excluded.rooms,updated_at=now();
  update public.profiles set table_id=null
    where table_id in (select id from public.tables where archived_at is null);
  update public.tables set archived_at=now(),is_paused=false where archived_at is null;
  update public.rooms set is_configured=false,archived_at=now() where archived_at is null;
  delete from public.display_calls where id is not null;
end $$;
drop function if exists public._force_complete_day_candidates(text);
notify pgrst,'reload schema';
