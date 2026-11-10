-- Coordinators choose the candidate's specialization at dispatch time for CM and TT.
-- Keep the two-argument RPC as a compatibility wrapper for existing callers.
drop function if exists public.assign_candidate(uuid, uuid);

create or replace function public.assign_candidate(
  p_candidate_id uuid,
  p_table_id uuid,
  p_specialization text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor public.profiles;
  t public.tables;
  c public.candidates;
  r public.rooms;
  v_specialization text := nullif(upper(btrim(coalesce(p_specialization, ''))), '');
begin
  v_actor := public._require_role(array['ADMIN','COORDINATOR']::public.user_role[]);
  select * into t from public.tables where id = p_table_id for update;
  if not found then raise exception 'Không tìm thấy bàn'; end if;
  if t.status <> 'AVAILABLE' then raise exception 'Bàn này đang bận'; end if;
  if t.is_paused then raise exception 'Bàn đang tạm dừng tiếp nhận thí sinh'; end if;
  select * into c from public.candidates where id = p_candidate_id for update;
  if not found then raise exception 'Không tìm thấy thí sinh'; end if;
  if c.status <> 'CHECKED_IN' or c.challenge_status is not null then
    raise exception 'Thí sinh không ở hàng chờ phỏng vấn thường';
  end if;
  select * into r from public.rooms where id = t.room_id;
  if not coalesce(r.is_configured, false) then raise exception 'Phòng chưa được kích hoạt'; end if;
  if coalesce(r.is_challenge, false) then raise exception 'Điều phối không thể gán thí sinh vào phòng thử thách'; end if;
  if t.department is null then raise exception 'Bàn chưa được cấu hình Ban'; end if;
  if c.department is distinct from t.department then raise exception 'Ban của thí sinh không khớp Ban phụ trách bàn'; end if;

  if t.department = 'CM' then
    if v_specialization is null or v_specialization not in ('HAT','NHAC_CU','RAP') then
      raise exception 'Điều phối cần chọn ngạch Chuyên Môn trước khi phân bàn';
    end if;
  elsif t.department = 'TT' then
    if v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT') then
      raise exception 'Điều phối cần chọn ngạch Truyền Thông trước khi phân bàn';
    end if;
  elsif v_specialization is not null then
    raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông';
  end if;

  if t.specialization is distinct from v_specialization then
    raise exception 'Ngạch đã chọn không khớp ngạch phụ trách bàn';
  end if;
  if not exists (select 1 from public.profiles p where p.table_id = t.id and p.role = 'INTERVIEWER') then
    raise exception 'Bàn chưa có tài khoản đại diện';
  end if;

  update public.tables set status = 'ASSIGNED', current_candidate_id = c.id,
    assigned_at = now(), started_at = null where id = t.id;
  update public.candidates set status = 'ASSIGNED', table_id = t.id,
    specialization = v_specialization, assigned_at = now() where id = c.id;
  perform pg_advisory_xact_lock(hashtext('display_calls:' || t.department));
  delete from public.display_calls where candidate_id = c.id;
  insert into public.display_calls(candidate_id,table_id,department,display_name,display_code,room_label)
    values(c.id,t.id,t.department,c.full_name,c.code,r.name);
  delete from public.display_calls d where d.department = t.department and d.id not in (
    select id from public.display_calls where department = t.department
    order by called_at desc,id desc limit 5
  );
end $$;

-- Preserve the old RPC for non-UI integrations; it can only use the stored specialization.
create or replace function public.assign_candidate(p_candidate_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_specialization text;
begin
  select specialization into v_specialization from public.candidates where id = p_candidate_id;
  perform public.assign_candidate(p_candidate_id, p_table_id, v_specialization);
end $$;

revoke execute on function public.assign_candidate(uuid, uuid, text) from public, anon;
grant execute on function public.assign_candidate(uuid, uuid, text) to authenticated;
revoke execute on function public.assign_candidate(uuid, uuid) from public, anon;
grant execute on function public.assign_candidate(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
