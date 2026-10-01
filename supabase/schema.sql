-- =====================================================================
-- Private Chat — complete Supabase schema
-- Run this whole file once in: Supabase Dashboard → SQL Editor → New query
-- It is safe to re-run (idempotent).
--
-- Model:
--   * Every device signs in with Supabase *anonymous* auth (no email, no
--     password, invisible to the user) and gets a short-lived JWT.
--   * join_room(code, participant) checks the shared chat code against a
--     bcrypt hash stored here and, if correct, adds the device to
--     room_members. The raw code never exists anywhere except in your head.
--   * Every RLS policy (tables, storage, realtime) = "is this JWT a member
--     of that room?".
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  room_name  text not null default 'Private Chat',
  code_hash  text not null,                       -- bcrypt hash of the chat code
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  user_id     uuid not null references auth.users (id) on delete cascade,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  participant text not null check (participant in ('a', 'b')),
  created_at  timestamptz not null default now(),
  primary key (user_id, room_id)
);
create index if not exists room_members_room_idx on public.room_members (room_id);

create table if not exists public.messages (
  id           uuid primary key,                  -- generated on the client (idempotent retries)
  room_id      uuid not null references public.rooms (id) on delete cascade,
  sender_id    text not null check (sender_id in ('a', 'b')),
  message_type text not null check (message_type in ('text', 'image')),
  content      text not null check (char_length(content) between 1 and 4000),
  created_at   timestamptz not null default now()
);
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);

-- Failed code attempts, for brute-force throttling.
create table if not exists public.access_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  created_at timestamptz not null default now()
);
create index if not exists access_attempts_created_idx on public.access_attempts (created_at);

-- ---------------------------------------------------------------------
-- Lock everything down. Browsers only get what is granted below.
-- ---------------------------------------------------------------------

alter table public.rooms           enable row level security;
alter table public.room_members    enable row level security;
alter table public.messages        enable row level security;
alter table public.access_attempts enable row level security;

revoke all on public.rooms, public.room_members, public.messages, public.access_attempts
  from anon, authenticated;
revoke all on sequence public.access_attempts_id_seq from anon, authenticated;

-- Members may read their room's messages. Nothing else is readable; all
-- writes go through the functions below.
grant select (id, room_id, sender_id, message_type, content, created_at)
  on public.messages to authenticated;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- "7462-ab91 xk" and "7462AB91XK" are the same code.
create or replace function public.normalize_code(p_code text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create or replace function public.is_room_member(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members
    where user_id = auth.uid() and room_id = p_room
  )
$$;

-- Same check, keyed by text (storage folder name / realtime topic) so a
-- malformed value can never raise a cast error inside a policy.
create or replace function public.is_room_member_text(p_room text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members
    where user_id = auth.uid() and room_id::text = p_room
  )
$$;

-- ---------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using (public.is_room_member(room_id));

-- (rooms, room_members, access_attempts: no policies → no direct access.)

-- ---------------------------------------------------------------------
-- RPC: join a room with the shared code
-- Returns {"room_id": ..., "room_name": ...} on success,
--         {"error": "invalid_code" | "rate_limited"} otherwise.
-- ---------------------------------------------------------------------

create or replace function public.join_room(p_code text, p_participant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := public.normalize_code(p_code);
  v_room public.rooms%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_participant not in ('a', 'b') then
    raise exception 'invalid participant' using errcode = '22023';
  end if;

  delete from public.access_attempts where created_at < now() - interval '1 day';

  -- Max 5 wrong codes per device per 15 min, max 50 overall per hour.
  if (select count(*) from public.access_attempts
        where user_id = v_uid and created_at > now() - interval '15 minutes') >= 5
     or (select count(*) from public.access_attempts
        where created_at > now() - interval '1 hour') >= 50 then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into v_room from public.rooms r
   where length(v_code) >= 6
     and r.code_hash = extensions.crypt(v_code, r.code_hash)
   limit 1;

  if not found then
    insert into public.access_attempts (user_id) values (v_uid);
    return jsonb_build_object('error', 'invalid_code');
  end if;

  insert into public.room_members (user_id, room_id, participant)
  values (v_uid, v_room.id, p_participant)
  on conflict (user_id, room_id) do update set participant = excluded.participant;

  return jsonb_build_object('room_id', v_room.id, 'room_name', v_room.room_name);
end $$;

-- ---------------------------------------------------------------------
-- RPC: send a message (idempotent on the client-generated id)
-- Returns the server timestamp of the stored message.
-- ---------------------------------------------------------------------

create or replace function public.send_message(p_id uuid, p_room uuid, p_type text, p_content text)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sender text;
  v_at     timestamptz;
  v_img    jsonb;
begin
  select participant into v_sender from public.room_members
   where user_id = auth.uid() and room_id = p_room;
  if v_sender is null then
    raise exception 'not a member' using errcode = '42501';
  end if;

  if p_type = 'text' then
    if char_length(btrim(coalesce(p_content, ''))) = 0 or char_length(p_content) > 4000 then
      raise exception 'invalid text' using errcode = '22023';
    end if;
  elsif p_type = 'image' then
    -- content = {"f": "<room>/<id>.jpg", "t": "<room>/<id>_t.jpg", "w": int, "h": int}
    v_img := p_content::jsonb;
    if coalesce(v_img ->> 'f', '') !~ ('^' || p_room::text || '/[A-Za-z0-9_-]+\.jpg$')
       or coalesce(v_img ->> 't', '') !~ ('^' || p_room::text || '/[A-Za-z0-9_-]+\.jpg$') then
      raise exception 'invalid image' using errcode = '22023';
    end if;
  else
    raise exception 'invalid type' using errcode = '22023';
  end if;

  insert into public.messages (id, room_id, sender_id, message_type, content)
  values (p_id, p_room, v_sender, p_type, p_content)
  on conflict (id) do nothing;

  select created_at into v_at from public.messages
   where id = p_id and room_id = p_room and sender_id = v_sender;
  if v_at is null then
    raise exception 'id conflict' using errcode = '23505';
  end if;
  return v_at;
end $$;

-- ---------------------------------------------------------------------
-- RPC: leave a room (removes this device's access)
-- ---------------------------------------------------------------------

create or replace function public.leave_room(p_room uuid)
returns void language sql volatile security definer set search_path = '' as $$
  delete from public.room_members where user_id = auth.uid() and room_id = p_room
$$;

-- ---------------------------------------------------------------------
-- Admin helper (SQL Editor only): create a room or change its code.
--   select public.set_room_code('Private Chat', '7462-AB91-XK');
-- Changing the code does NOT kick existing devices; see README.
-- ---------------------------------------------------------------------

create or replace function public.set_room_code(p_room_name text, p_code text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text := public.normalize_code(p_code);
  v_id   uuid;
begin
  if length(v_code) < 10 then
    raise exception 'Use a code with at least 10 letters/digits.';
  end if;
  update public.rooms
     set code_hash = extensions.crypt(v_code, extensions.gen_salt('bf', 10))
   where room_name = p_room_name
  returning id into v_id;
  if v_id is null then
    insert into public.rooms (room_name, code_hash)
    values (p_room_name, extensions.crypt(v_code, extensions.gen_salt('bf', 10)))
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Supabase grants EXECUTE on new functions to everyone by default. Undo that.
revoke execute on function public.normalize_code(text)                      from public, anon, authenticated;
revoke execute on function public.is_room_member(uuid)                      from public, anon;
revoke execute on function public.is_room_member_text(text)                 from public, anon;
revoke execute on function public.join_room(text, text)                     from public, anon;
revoke execute on function public.send_message(uuid, uuid, text, text)      from public, anon;
revoke execute on function public.leave_room(uuid)                          from public, anon;
revoke execute on function public.set_room_code(text, text)                 from public, anon, authenticated;

grant execute on function public.is_room_member(uuid)                 to authenticated;
grant execute on function public.is_room_member_text(text)            to authenticated;
grant execute on function public.join_room(text, text)                to authenticated;
grant execute on function public.send_message(uuid, uuid, text, text) to authenticated;
grant execute on function public.leave_room(uuid)                     to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: push each new message to the room's PRIVATE channel
-- "room:<room_id>". Only members may subscribe (policy below).
-- ---------------------------------------------------------------------

create or replace function public.broadcast_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'sender_id', new.sender_id,
      'message_type', new.message_type,
      'content', new.content,
      'created_at', new.created_at
    ),
    'msg',
    'room:' || new.room_id::text,
    true
  );
  return null;
end $$;
revoke execute on function public.broadcast_new_message() from public, anon, authenticated;

drop trigger if exists messages_broadcast on public.messages;
create trigger messages_broadcast
  after insert on public.messages
  for each row execute function public.broadcast_new_message();

drop policy if exists "chat members receive room broadcasts" on realtime.messages;
create policy "chat members receive room broadcasts" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'room:%'
    and public.is_room_member_text(substr((select realtime.topic()), 6))
  );

-- ---------------------------------------------------------------------
-- Storage: private bucket, objects live under "<room_id>/..."
-- Members may upload new objects and read objects of their room.
-- No update / delete policies → nobody can overwrite or remove photos.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-photos', 'chat-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat photos: members read" on storage.objects;
create policy "chat photos: members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-photos'
    and public.is_room_member_text((storage.foldername(name))[1])
  );

drop policy if exists "chat photos: members upload" on storage.objects;
create policy "chat photos: members upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-photos'
    and public.is_room_member_text((storage.foldername(name))[1])
  );
