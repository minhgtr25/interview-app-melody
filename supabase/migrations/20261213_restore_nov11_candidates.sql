-- Restore Nov 11 candidates accidentally completed by the forced rollover.
-- The exact note and scheduled date keep this repair away from valid interviews.
with affected as materialized (
  select c.id, c.interview_note,
    case
      when c.interview_note like '%Trạng thái trước: Chưa đến%' then 'NOT_ARRIVED'
      when c.interview_note like '%Trạng thái trước: Đã check-in%' then 'CHECKED_IN'
      when c.interview_note like '%Trạng thái trước: Đã vào bàn%' then 'CHECKED_IN'
      when c.interview_note like '%Trạng thái trước: Đang phỏng vấn%' then 'CHECKED_IN'
      when c.interview_note like '%Trạng thái trước: Vắng%' then 'ABSENT'
      when c.interview_note like '%Trạng thái trước: Hoàn thành%' then 'COMPLETED'
    end as restored_status,
    c.interview_note like '%thử thách WAITING%'
      or c.interview_note like '%thử thách ASSIGNED%'
      or c.interview_note like '%thử thách INTERVIEWING%' as was_in_challenge_queue
  from public.candidates c
  where c.status='COMPLETED'
    and c.shift ~ '^\d{2}/\d{2}/2026 '
    and to_date(left(c.shift,10),'DD/MM/YYYY')=date '2026-11-11'
    and c.interview_note like 'Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026 · Trạng thái trước:%'
),
restored as (
  update public.candidates c set
    status=case when a.restored_status in ('ASSIGNED','INTERVIEWING') then 'CHECKED_IN'::public.candidate_status
      else a.restored_status::public.candidate_status end,
    challenge_status=case when a.was_in_challenge_queue then 'WAITING' else null end,
    debate_request_status=case when a.was_in_challenge_queue then 'WAITING' else null end,
    debate_requested_from_table_id=null,
    debate_batch_number=null,
    debate_slot_number=null,
    table_id=case when a.restored_status='COMPLETED' then c.table_id else null end,
    assigned_at=case when a.restored_status='COMPLETED' then c.assigned_at else null end,
    interview_started_at=case when a.restored_status='COMPLETED' then c.interview_started_at else null end,
    interview_ended_at=case when a.restored_status='COMPLETED' then coalesce(
      (select e.ended_at from public.evaluations e where e.candidate_id=c.id),c.interview_ended_at
    ) else null end,
    duration_seconds=case when a.restored_status='COMPLETED' then coalesce(
      (select e.duration_seconds from public.evaluations e where e.candidate_id=c.id),c.duration_seconds
    ) else 0 end,
    interview_note=case when position(E'\n' in a.interview_note)>0
      then substring(a.interview_note from position(E'\n' in a.interview_note)+1) else null end
  from affected a where c.id=a.id and a.restored_status is not null
  returning c.id
),
deleted_placeholders as (
  delete from public.evaluations e using affected a
  where e.candidate_id=a.id
    and a.restored_status is not null
    and e.comment like 'Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026 · Trạng thái trước:%'
    and e.scores='{}'::jsonb and e.average_score is null
    and e.started_at is null and e.ended_at is null
  returning e.id
),
restored_challenge_reviews as (
  update public.evaluations e set
    challenge_comment=case when position(E'\n' in e.challenge_comment)>0
      then substring(e.challenge_comment from position(E'\n' in e.challenge_comment)+1) else null end,
    challenge_table_label=null,
    challenge_ended_at=null
  from affected a
  where e.candidate_id=a.id and a.was_in_challenge_queue
    and a.restored_status is not null
    and e.comment not like 'Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026 · Trạng thái trước:%'
    and e.challenge_comment like 'Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026 · Trạng thái trước:%'
  returning e.id
),
reopened_requests as (
  update public.schedule_requests r set status='PENDING',reviewed_at=null,
    review_note=case when position(E'\n' in r.review_note)>0
      then substring(r.review_note from position(E'\n' in r.review_note)+1) else '' end
  from affected a
  where r.candidate_id=a.id
    and a.restored_status is not null
    and r.review_note like 'Cưỡng chế kết thúc khi chuyển sang ngày 11/11/2026%'
  returning r.id
)
select count(*) from restored;

notify pgrst,'reload schema';
