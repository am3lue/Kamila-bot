-- Kamila OTP gateway schema.
--
-- The Node server talks to these tables with the Supabase service-role key.
-- RLS is enabled with no policies, so the anon/authenticated roles (and any
-- Tausi JWT presented to PostgREST) can't read or write anything here.

create table if not exists public.gw_settings (
  key   text primary key,
  value text not null
);

create table if not exists public.gw_sessions (
  id              text primary key,
  owner_id        text,                       -- Tausi user id; null = system session (the AI bot "default")
  name            text not null check (char_length(name) between 1 and 60),
  api_key_hash    text not null unique,
  api_key_prefix  text not null,
  webhook_url     text,
  webhook_secret  text not null,
  webhook_events  jsonb not null default '["otp.sent","otp.status","otp.verified","session.status"]'::jsonb,
  otp_template    text check (otp_template is null or char_length(otp_template) <= 500),
  ai_bot          boolean not null default false,
  auto_start      boolean not null default true,
  phone           text,
  push_name       text,
  created_at      timestamptz not null default now()
);
create index if not exists gw_sessions_owner_idx on public.gw_sessions (owner_id);

create table if not exists public.gw_otps (
  id            text primary key,
  session_id    text not null references public.gw_sessions (id) on delete cascade,
  phone         text not null,
  chat_id       text not null,
  code_hash     text not null,
  message_id    text,
  status        text not null default 'PENDING'
                check (status in ('PENDING','SENT','DELIVERED','READ','VERIFIED','EXPIRED','BLOCKED','FAILED','CANCELLED')),
  attempts      int  not null default 0,
  max_attempts  int  not null default 5,
  expires_at    timestamptz not null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists gw_otps_phone_idx   on public.gw_otps (session_id, phone, created_at desc);
create index if not exists gw_otps_message_idx on public.gw_otps (message_id);
create index if not exists gw_otps_active_idx  on public.gw_otps (expires_at)
  where status in ('PENDING','SENT','DELIVERED','READ');

create table if not exists public.gw_webhook_logs (
  id           bigint generated always as identity primary key,
  session_id   text not null references public.gw_sessions (id) on delete cascade,
  event        text not null,
  url          text not null,
  attempt      int  not null,
  status_code  int,
  error        text,
  duration_ms  int,
  created_at   timestamptz not null default now()
);
create index if not exists gw_webhook_logs_session_idx on public.gw_webhook_logs (session_id, id desc);

alter table public.gw_settings     enable row level security;
alter table public.gw_sessions     enable row level security;
alter table public.gw_otps         enable row level security;
alter table public.gw_webhook_logs enable row level security;

-- ── Create an OTP atomically ──
-- Serialises on (session, phone) so concurrent requests can't both pass the
-- resend cooldown, then supersedes older active codes and inserts the new one.
create or replace function public.gw_create_otp(
  p_id text, p_session text, p_phone text, p_chat text, p_hash text,
  p_ttl_seconds int, p_max_attempts int, p_cooldown_seconds int, p_max_per_hour int
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_last  timestamptz;
  v_count int;
  v_exp   timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_session || ':' || p_phone));

  select created_at into v_last
    from gw_otps
   where session_id = p_session and phone = p_phone and status <> 'FAILED'
   order by created_at desc
   limit 1;
  if v_last is not null and now() - v_last < make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object('ok', false, 'error', 'resend_cooldown',
      'retry_after', greatest(1, ceil(p_cooldown_seconds - extract(epoch from now() - v_last)))::int);
  end if;

  select count(*) into v_count
    from gw_otps
   where session_id = p_session and phone = p_phone and status <> 'FAILED'
     and created_at > now() - interval '1 hour';
  if v_count >= p_max_per_hour then
    return jsonb_build_object('ok', false, 'error', 'hourly_limit');
  end if;

  update gw_otps set status = 'CANCELLED', updated_at = now()
   where session_id = p_session and phone = p_phone
     and status in ('PENDING','SENT','DELIVERED','READ');

  insert into gw_otps (id, session_id, phone, chat_id, code_hash, max_attempts, expires_at)
  values (p_id, p_session, p_phone, p_chat, p_hash, p_max_attempts, now() + make_interval(secs => p_ttl_seconds))
  returning expires_at into v_exp;

  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end;
$$;

-- ── Count a verification attempt (only while the code is still usable) ──
create or replace function public.gw_otp_attempt(p_id text)
returns table (attempts int, max_attempts int)
language sql
set search_path = public
as $$
  update gw_otps o
     set attempts = o.attempts + 1, updated_at = now()
   where o.id = p_id and o.status in ('PENDING','SENT','DELIVERED','READ')
  returning o.attempts, o.max_attempts;
$$;

-- ── Per-session counts for today (UTC) ──
create or replace function public.gw_today_counts(p_ids text[])
returns table (session_id text, sent bigint, verified bigint)
language sql
stable
set search_path = public
as $$
  select o.session_id,
         count(*) filter (where o.status <> 'FAILED'),
         count(*) filter (where o.status = 'VERIFIED')
    from gw_otps o
   where o.session_id = any (p_ids)
     and o.created_at >= date_trunc('day', now())
   group by o.session_id;
$$;

-- Only the server (service role) may call these through PostgREST.
revoke execute on function public.gw_create_otp(text, text, text, text, text, int, int, int, int) from public, anon, authenticated;
revoke execute on function public.gw_otp_attempt(text) from public, anon, authenticated;
revoke execute on function public.gw_today_counts(text[]) from public, anon, authenticated;
grant  execute on function public.gw_create_otp(text, text, text, text, text, int, int, int, int) to service_role;
grant  execute on function public.gw_otp_attempt(text) to service_role;
grant  execute on function public.gw_today_counts(text[]) to service_role;
