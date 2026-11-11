-- Save yesterday's layout, then start the new Hanoi calendar day with no rooms or desks.
-- Keep old rows for candidate, evaluation, chat and Debate history; RLS hides them
-- from the live workspace. Judge accounts become available for reassignment.
alter table public.rooms add column if not exists archived_at timestamptz;
alter table public.tables add column if not exists archived_at timestamptz;

create or replace function public._current_interview_room_plan() returns jsonb
language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'building_code', r.building_code,
    'room_number', r.room_number, 'is_configured', r.is_configured,
    'is_challenge', r.is_challenge, 'external_challenge', r.external_challenge,
    'sort_order', r.sort_order,
    'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'department', t.department,
      'specialization', t.specialization, 'sort_order', t.sort_order,
      'is_paused', t.is_paused,
      'judges', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.full_name, 'email', p.email,
        'position', p.debate_judge_position) order by p.debate_judge_position,p.id)
        from public.profiles p where p.table_id=t.id and p.role='INTERVIEWER'), '[]'::jsonb))
      order by t.sort_order, t.id)
      from public.tables t where t.room_id=r.id and t.archived_at is null), '[]'::jsonb)
  ) order by r.sort_order, r.id), '[]'::jsonb)
  from public.rooms r where r.archived_at is null
$$;

create or replace function public._guard_interview_day_configuration() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_active_day date;
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select day into v_active_day from public.interview_day_state where id='main';
  if v_active_day is distinct from v_today then
    raise exception 'Bố trí ngày đã khóa. Chỉ được chỉnh phòng và bàn trong ngày hiện tại';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
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
  delete from public.display_calls;

  -- A previously saved future layout must not become today's configuration.
  insert into public.interview_day_plans(day,rooms) values(p_day,'[]'::jsonb)
    on conflict(day) do update set rooms='[]'::jsonb,updated_at=now();
end $$;

create or replace function public.ensure_interview_day() returns date
language plpgsql security definer set search_path=public as $$
declare
  v_today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_active_day date;
begin
  perform public._require_role(array['ADMIN','CHECKIN','COORDINATOR','INTERVIEWER']::public.user_role[]);
  select day into v_active_day from public.interview_day_state where id='main' for update;
  if v_active_day<v_today then
    perform public._apply_interview_day(v_today);
    return v_today;
  end if;
  return v_active_day;
end $$;

create or replace function public.save_interview_day_plan(p_day date,p_rooms jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
  raise exception 'Bố trí bàn được tạo mới trong ngày phỏng vấn; không sao chép từ ngày cũ';
end $$;

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using (public.is_staff() and archived_at is null);
drop policy if exists rooms_admin_all on public.rooms;
create policy rooms_admin_all on public.rooms for all to authenticated
  using (public.is_admin() and archived_at is null)
  with check (public.is_admin() and archived_at is null);
drop policy if exists tables_select on public.tables;
create policy tables_select on public.tables for select to authenticated
  using (public.is_staff() and archived_at is null);
drop policy if exists tables_admin_all on public.tables;
create policy tables_admin_all on public.tables for all to authenticated
  using (public.is_admin() and archived_at is null)
  with check (public.is_admin() and archived_at is null);

revoke execute on function public.save_interview_day_plan(date,jsonb) from public,anon,authenticated;
revoke execute on function public._apply_interview_day(date) from public,anon,authenticated;
revoke execute on function public.ensure_interview_day() from public,anon;
grant execute on function public.ensure_interview_day() to authenticated;
-- Admin can clear today's already-applied legacy layout without changing the date.
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
  delete from public.display_calls;
end $$;
revoke execute on function public.reset_today_interview_rooms() from public,anon;
grant execute on function public.reset_today_interview_rooms() to authenticated;
notify pgrst,'reload schema';
