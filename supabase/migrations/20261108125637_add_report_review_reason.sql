alter table public.reports
  add column review_reason text,
  add constraint report_review_reason_limit
    check (review_reason is null or char_length(review_reason) <= 500);

update public.reports as report
set review_reason = (
  select audit.reason
  from public.moderation_audit as audit
  where audit.action = 'dismiss_report'
    and audit.metadata ->> 'report_id' = report.id::text
  order by audit.created_at desc
  limit 1
)
where report.status = 'dismissed'
  and report.review_reason is null
  and exists (
    select 1
    from public.moderation_audit as audit
    where audit.action = 'dismiss_report'
      and audit.metadata ->> 'report_id' = report.id::text
  );
