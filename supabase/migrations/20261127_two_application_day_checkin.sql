  -- Run after 20261126_reschedule_requires_checkin.sql.
  -- Each department remains a separate candidate row. A changed future schedule
  -- must return an unchecked application to Check-in instead of leaving it in the
  -- coordinator queue from the previous interview day.

  -- Linked application rows repeat the root candidate's student number. Keep it
  -- unique on the root record while allowing the same number on linked rounds.
  alter table public.candidates drop constraint if exists candidates_student_number_key;
  create unique index if not exists candidates_root_student_number_key
    on public.candidates(student_number) where source_candidate_id is null;

  -- Keep the second application self-contained, including its student number.
  create or replace function public.inherit_candidate_application_info() returns trigger
  language plpgsql security definer set search_path=public as $$
  declare
    v_root public.candidates;
  begin
    if new.source_candidate_id is null then return new; end if;
    select * into v_root from public.candidates where id=new.source_candidate_id;
    if not found then raise exception 'Không tìm thấy hồ sơ thí sinh gốc'; end if;
    new.student_number:=coalesce(nullif(btrim(new.student_number),''),v_root.student_number);
    new.student_cohort:=coalesce(nullif(btrim(new.student_cohort),''),v_root.student_cohort);
    new.gender:=coalesce(nullif(btrim(new.gender),''),v_root.gender);
    new.facebook_url:=coalesce(nullif(btrim(new.facebook_url),''),v_root.facebook_url);
    new.phone:=coalesce(nullif(btrim(new.phone),''),v_root.phone);
    new.email:=coalesce(nullif(btrim(new.email),''),v_root.email);
    new.cv_url:=coalesce(nullif(btrim(new.cv_url),''),v_root.cv_url);
    return new;
  end $$;
  drop trigger if exists candidates_inherit_application_info on public.candidates;
  create trigger candidates_inherit_application_info before insert on public.candidates
    for each row execute function public.inherit_candidate_application_info();
  revoke execute on function public.inherit_candidate_application_info() from public,anon,authenticated;

  -- Importing a changed schedule resets stale attendance only when the application
  -- has not been assigned, interviewed, or evaluated.
  create or replace function public._upsert_candidate_schedule(p_root_id uuid,p_department text,p_shift text)
  returns void language plpgsql security definer set search_path=public as $$
  declare
    v_root public.candidates;
    v_application_id uuid;
  begin
    select * into v_root from public.candidates where id=p_root_id and source_candidate_id is null for update;
    if not found then raise exception 'Không tìm thấy hồ sơ thí sinh gốc'; end if;
    if v_root.department=p_department then
      update public.candidates c set shift=p_shift,
        status=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then 'NOT_ARRIVED'::public.candidate_status else c.status end,
        checked_in_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then null else c.checked_in_at end,
        absent_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then null else c.absent_at end
      where c.id=v_root.id;
      return;
    end if;

    select id into v_application_id from public.candidates
      where source_candidate_id=v_root.id and department=p_department for update;
    if v_application_id is null then
      insert into public.candidates
        (code,full_name,student_number,student_cohort,gender,facebook_url,phone,email,
        department,shift,cv_url,source_candidate_id,status)
      values
        (public._next_candidate_code(),v_root.full_name,v_root.student_number,v_root.student_cohort,
        v_root.gender,v_root.facebook_url,v_root.phone,v_root.email,p_department,p_shift,
        v_root.cv_url,v_root.id,'NOT_ARRIVED');
    else
      update public.candidates c set shift=p_shift,
        status=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then 'NOT_ARRIVED'::public.candidate_status else c.status end,
        checked_in_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then null else c.checked_in_at end,
        absent_at=case when c.shift is distinct from p_shift and c.status in ('CHECKED_IN','ABSENT')
            and c.challenge_status is null and c.table_id is null and c.challenge_table_id is null
            and not exists(select 1 from public.evaluations e where e.candidate_id=c.id)
          then null else c.absent_at end
      where c.id=v_application_id;
    end if;
  end $$;
  revoke execute on function public._upsert_candidate_schedule(uuid,text,text) from public,anon,authenticated;

  -- Admin schedule edits follow the same re-check-in rule as approved requests.
  create or replace function public.update_candidate_schedules(p_updates jsonb) returns void
  language plpgsql security definer set search_path=public as $$
  declare
    v_row record;
    v_candidate public.candidates;
    v_root_id uuid;
    v_date text;
    v_hour integer;
    v_minute integer;
    v_shift text;
    v_reset boolean;
  begin
    perform public._require_role(array['ADMIN']::public.user_role[]);
    if p_updates is null or jsonb_typeof(p_updates)<>'array' or jsonb_array_length(p_updates) not between 1 and 8 then
      raise exception 'Danh sách Ca không hợp lệ';
    end if;
    for v_row in select * from jsonb_to_recordset(p_updates) as x(id uuid,shift text) loop
      select * into v_candidate from public.candidates where id=v_row.id for update;
      if not found then raise exception 'Không tìm thấy thí sinh'; end if;
      if v_root_id is null then v_root_id:=coalesce(v_candidate.source_candidate_id,v_candidate.id); end if;
      if coalesce(v_candidate.source_candidate_id,v_candidate.id)<>v_root_id then
        raise exception 'Các Ca phải thuộc cùng một thí sinh';
      end if;
      v_shift:=nullif(btrim(v_row.shift),'');
      if v_shift is not null then
        if v_shift !~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$' or
          (regexp_match(v_shift,'\(([A-Z]+)\)$'))[1] is distinct from v_candidate.department then
          raise exception 'Ca không khớp Ban của thí sinh';
        end if;
        v_date:=left(v_shift,10);
        perform make_date(substring(v_date,7,4)::int,substring(v_date,4,2)::int,left(v_date,2)::int);
        v_hour:=substring(v_shift,12,2)::int;
        v_minute:=substring(v_shift,15,2)::int;
        if v_hour>23 or v_minute>59 then raise exception 'Giờ phỏng vấn không hợp lệ'; end if;
      end if;

      v_reset:=v_candidate.shift is distinct from v_shift
        and v_candidate.status in ('CHECKED_IN','ABSENT')
        and v_candidate.challenge_status is null
        and v_candidate.table_id is null and v_candidate.challenge_table_id is null
        and not exists(select 1 from public.evaluations e where e.candidate_id=v_candidate.id);
      update public.candidates set shift=v_shift,
        status=case when v_reset then 'NOT_ARRIVED'::public.candidate_status else v_candidate.status end,
        checked_in_at=case when v_reset then null else v_candidate.checked_in_at end,
        absent_at=case when v_reset then null else v_candidate.absent_at end
        where id=v_candidate.id;
    end loop;
  end $$;
  revoke execute on function public.update_candidate_schedules(jsonb) from public,anon;
  grant execute on function public.update_candidate_schedules(jsonb) to authenticated;

  -- Repair old second applications accidentally left checked in from their first
  -- interview day. Preserve rows that have reached a desk or have an evaluation.
  update public.candidates child set status='NOT_ARRIVED',checked_in_at=null,absent_at=null
  where child.source_candidate_id is not null
    and child.status='CHECKED_IN'
    and child.challenge_status is null
    and child.shift ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2} \([A-Z]+\)$'
    and (child.checked_in_at is null or child.checked_in_at <
      (to_date(left(child.shift,10),'DD/MM/YYYY')::timestamp at time zone 'Asia/Ho_Chi_Minh'))
    and child.table_id is null and child.challenge_table_id is null
    and not exists(select 1 from public.evaluations e where e.candidate_id=child.id)
    and exists(select 1 from public.candidates parent where parent.id=child.source_candidate_id and parent.status='COMPLETED');

  -- Fill missing student numbers on legacy linked applications.
  update public.candidates child set student_number=parent.student_number
  from public.candidates parent
  where child.source_candidate_id=parent.id and child.student_number is null and parent.student_number is not null;

  notify pgrst,'reload schema';
