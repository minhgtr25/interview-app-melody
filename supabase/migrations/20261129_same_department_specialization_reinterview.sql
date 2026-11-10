-- Run after 20261128_rollover_absent_applications.sql.
-- A CM candidate may have one additional CM application only when it uses a
-- different specialization. Linked applications share the root MSSV.

-- The old model allowed only one linked application per root candidate.
drop index if exists public.candidates_one_second_interview;
alter table public.candidates drop constraint if exists candidates_student_number_key;
create unique index if not exists candidates_root_student_number_key
  on public.candidates(student_number) where source_candidate_id is null;

create or replace function public.submit_evaluation_with_referral(
  p_table_id uuid, p_scores jsonb, p_comment text,
  p_second_department text, p_second_specialization text
) returns public.evaluations
language plpgsql security definer set search_path=public as $$
declare
  t public.tables;
  c public.candidates;
  v_child public.candidates;
  v_child_found boolean := false;
  v_other_application boolean := false;
  v_has_evaluation boolean := false;
  v_eval public.evaluations;
  v_specialization text := nullif(upper(btrim(coalesce(p_second_specialization,''))), '');
begin
  perform public._require_role(array['ADMIN','INTERVIEWER']::public.user_role[]);

  if p_second_department is null then
    if v_specialization is not null then raise exception 'Chưa chọn Ban thứ hai'; end if;
  else
    if p_second_department not in ('CM','VH','TT','ND','HCTC') then
      raise exception 'Ban thứ hai không hợp lệ';
    end if;
    if p_second_department = 'CM' then
      if v_specialization is null or v_specialization not in ('HAT','NHAC_CU','RAP') then
        raise exception 'Chọn ngạch Chuyên Môn cho lượt tiếp theo';
      end if;
    elsif p_second_department = 'TT' then
      if v_specialization is null or v_specialization not in ('MEDIA','DESIGN','CONTENT') then
        raise exception 'Chọn ngạch Truyền Thông cho lượt thứ hai';
      end if;
    elsif v_specialization is not null then
      raise exception 'Ngạch chỉ áp dụng cho Chuyên Môn và Truyền Thông';
    end if;

    select * into t from public.tables where id=p_table_id for update;
    if not found or t.department is distinct from 'CM' or t.current_candidate_id is null then
      raise exception 'Chỉ bàn Chuyên Môn được chọn lượt phỏng vấn tiếp theo';
    end if;
    select * into c from public.candidates where id=t.current_candidate_id for update;
    if c.department is distinct from 'CM' or c.source_candidate_id is not null then
      raise exception 'Chỉ hồ sơ Chuyên Môn gốc được chọn lượt phỏng vấn tiếp theo';
    end if;

    if p_second_department = 'CM' then
      if c.specialization is null or c.specialization = v_specialization then
        raise exception 'Lượt Chuyên Môn tiếp theo phải chọn ngạch khác ngạch hiện tại';
      end if;
      select * into v_child from public.candidates
        where source_candidate_id=c.id and department='CM' and specialization=v_specialization
        order by created_at,id limit 1 for update;
      v_child_found := found;
      if v_child_found then
        select exists(select 1 from public.evaluations e where e.candidate_id=v_child.id)
          into v_has_evaluation;
        if v_has_evaluation or v_child.status in ('ASSIGNED','INTERVIEWING','COMPLETED') then
          raise exception 'Thí sinh đã có lượt Chuyên Môn ở ngạch này';
        end if;
      end if;
      select exists(select 1 from public.candidates x
        where x.source_candidate_id=c.id and (not v_child_found or x.id<>v_child.id))
        into v_other_application;
      if v_other_application then
        raise exception 'Thí sinh đã có một lượt Ban thứ hai được đăng ký';
      end if;
    else
      select * into v_child from public.candidates
        where source_candidate_id=c.id order by created_at,id limit 1 for update;
      v_child_found := found;
      if v_child_found and v_child.department is distinct from p_second_department then
        raise exception 'Thí sinh đã đăng ký lượt tiếp theo ở Ban %',v_child.department;
      end if;
      if v_child_found and v_child.department='TT' and v_child.specialization is not null
        and v_child.specialization is distinct from v_specialization then
        raise exception 'Ngạch Truyền Thông không khớp lịch đã cấu hình';
      end if;
      if v_child_found then
        select exists(select 1 from public.evaluations e where e.candidate_id=v_child.id)
          into v_has_evaluation;
        if v_has_evaluation or v_child.status in ('ASSIGNED','INTERVIEWING','COMPLETED') then
          raise exception 'Thí sinh đã hoàn tất lượt phỏng vấn tiếp theo';
        end if;
      end if;
    end if;
  end if;

  v_eval := public.submit_evaluation(p_table_id,p_scores,p_comment);
  if p_second_department is not null then
    if not v_child_found then
      insert into public.candidates
        (code,full_name,student_cohort,gender,facebook_url,phone,email,
         department,specialization,cv_url,source_candidate_id,status,checked_in_at)
      values
        (public._next_candidate_code(),c.full_name,c.student_cohort,c.gender,c.facebook_url,
         c.phone,c.email,p_second_department,v_specialization,c.cv_url,c.id,'CHECKED_IN',now());
    elsif v_child.department='TT' and v_child.specialization is null then
      update public.candidates set specialization=v_specialization where id=v_child.id;
    end if;
  end if;
  return v_eval;
end $$;

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
  if p_second_department is null and (p_second_shift is not null or p_second_specialization is not null) then
    raise exception 'Chưa chọn Ban thứ hai';
  end if;
  if p_second_shift is not null then perform public._validate_event_shift(p_second_shift,p_second_department); end if;
  select current_candidate_id into v_candidate_id from public.tables where id=p_table_id;
  if v_candidate_id is null then raise exception 'Bàn không có thí sinh đang phỏng vấn'; end if;

  v_eval:=public.submit_evaluation_with_referral(
    p_table_id,p_scores,p_comment,p_second_department,p_second_specialization
  );
  if p_second_department is null then return v_eval; end if;

  select * into v_child from public.candidates
    where source_candidate_id=v_candidate_id
      and department=p_second_department
      and (p_second_department<>'CM' or specialization=nullif(upper(btrim(coalesce(p_second_specialization,''))),''))
    order by created_at,id limit 1 for update;
  if not found then raise exception 'Không tìm thấy hồ sơ lượt phỏng vấn tiếp theo'; end if;

  if p_second_shift is not null then
    v_day:=public._validate_event_shift(p_second_shift,v_child.department);
    update public.candidates set shift=p_second_shift,
      status=case when v_day>v_today then 'NOT_ARRIVED'::public.candidate_status
        else 'CHECKED_IN'::public.candidate_status end,
      checked_in_at=case when v_day>v_today then null else coalesce(checked_in_at,now()) end,
      absent_at=null
      where id=v_child.id;
    update public.schedule_requests set status='RESOLVED',reviewed_at=now()
      where candidate_id=v_child.id and kind='FOLLOWUP_UNDECIDED' and status='PENDING';
  elsif v_child.shift is null then
    insert into public.schedule_requests(candidate_id,kind,reason,requested_by,requested_role)
      values(v_child.id,'FOLLOWUP_UNDECIDED','Giám khảo Chuyên môn chưa chốt Ca lượt tiếp theo',v_user.id,v_user.role)
      on conflict(candidate_id,kind) where status='PENDING' do nothing;
  elsif v_child.status in ('NOT_ARRIVED','ABSENT') and
    to_date(left(v_child.shift,10),'DD/MM/YYYY')=v_today then
    update public.candidates set status='CHECKED_IN',checked_in_at=coalesce(checked_in_at,now()),absent_at=null
      where id=v_child.id;
  end if;
  return v_eval;
end $$;

revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) from public,anon;
revoke execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) from public,anon;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text) to authenticated;
grant execute on function public.submit_evaluation_with_referral(uuid,jsonb,text,text,text,text) to authenticated;
notify pgrst,'reload schema';
