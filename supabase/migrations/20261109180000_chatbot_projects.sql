-- Projects can now be either an OTP sender or an AI chatbot (Gemini).

alter table public.gw_sessions
  add column if not exists mode text not null default 'otp',
  add column if not exists bot_instructions text,
  add column if not exists knowledge_base text,
  add column if not exists answer_url text,
  add column if not exists gemini_api_key_enc text,   -- AES-256-GCM, never returned by the API
  add column if not exists gemini_model text;

do $$ begin
  alter table public.gw_sessions add constraint gw_sessions_mode_chk check (mode in ('otp', 'chatbot'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.gw_sessions add constraint gw_sessions_kb_len_chk check (knowledge_base is null or char_length(knowledge_base) <= 200000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.gw_sessions add constraint gw_sessions_instr_len_chk check (bot_instructions is null or char_length(bot_instructions) <= 4000);
exception when duplicate_object then null; end $$;

-- Chatbot conversation history (context for replies + the dashboard log).
create table if not exists public.gw_messages (
  id          bigint generated always as identity primary key,
  session_id  text not null references public.gw_sessions (id) on delete cascade,
  chat_id     text not null,
  role        text not null check (role in ('user', 'bot')),
  text        text not null,
  source      text,                      -- bot replies: 'gemini' | 'answer_url'
  created_at  timestamptz not null default now()
);
create index if not exists gw_messages_chat_idx on public.gw_messages (session_id, chat_id, id desc);
create index if not exists gw_messages_session_idx on public.gw_messages (session_id, id desc);
alter table public.gw_messages enable row level security;

-- Today's chatbot activity per session (UTC).
create or replace function public.gw_today_chat_counts(p_ids text[])
returns table (session_id text, received bigint, replied bigint)
language sql
stable
set search_path = public
as $$
  select m.session_id,
         count(*) filter (where m.role = 'user'),
         count(*) filter (where m.role = 'bot')
    from gw_messages m
   where m.session_id = any (p_ids)
     and m.created_at >= date_trunc('day', now())
   group by m.session_id;
$$;
revoke execute on function public.gw_today_chat_counts(text[]) from public, anon, authenticated;
grant  execute on function public.gw_today_chat_counts(text[]) to service_role;
