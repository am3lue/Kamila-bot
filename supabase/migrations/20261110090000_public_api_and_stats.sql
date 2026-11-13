-- Public API: publishable keys for the website chat widget, conversation
-- channels, and daily stats for the dashboard charts.

alter table public.gw_sessions
  add column if not exists publishable_key text,
  add column if not exists allowed_origins text[] not null default '{}',
  add column if not exists widget_settings jsonb not null default '{}'::jsonb;
create unique index if not exists gw_sessions_publishable_key_idx on public.gw_sessions (publishable_key) where publishable_key is not null;

alter table public.gw_messages
  add column if not exists channel text not null default 'whatsapp';
do $$ begin
  alter table public.gw_messages add constraint gw_messages_channel_chk check (channel in ('whatsapp', 'api', 'widget'));
exception when duplicate_object then null; end $$;

-- Daily activity per project for the last p_days days (UTC), zero-filled.
create or replace function public.gw_daily_stats(p_ids text[], p_days int)
returns table (session_id text, day date, otp_sent bigint, otp_verified bigint, msg_in bigint, msg_out bigint)
language sql
stable
set search_path = public
as $$
  with days as (
    select generate_series((now() at time zone 'utc')::date - (p_days - 1), (now() at time zone 'utc')::date, interval '1 day')::date as day
  ),
  ids as (select unnest(p_ids) as session_id),
  o as (
    select session_id, (created_at at time zone 'utc')::date as day,
           count(*) filter (where status <> 'FAILED') as sent,
           count(*) filter (where status = 'VERIFIED') as verified
      from gw_otps
     where session_id = any (p_ids) and created_at >= now() - make_interval(days => p_days + 1)
     group by 1, 2
  ),
  m as (
    select session_id, (created_at at time zone 'utc')::date as day,
           count(*) filter (where role = 'user') as msg_in,
           count(*) filter (where role = 'bot') as msg_out
      from gw_messages
     where session_id = any (p_ids) and created_at >= now() - make_interval(days => p_days + 1)
     group by 1, 2
  )
  select ids.session_id, days.day,
         coalesce(o.sent, 0), coalesce(o.verified, 0), coalesce(m.msg_in, 0), coalesce(m.msg_out, 0)
    from ids cross join days
    left join o on o.session_id = ids.session_id and o.day = days.day
    left join m on m.session_id = ids.session_id and m.day = days.day
   order by 1, 2;
$$;
revoke execute on function public.gw_daily_stats(text[], int) from public, anon, authenticated;
grant  execute on function public.gw_daily_stats(text[], int) to service_role;
