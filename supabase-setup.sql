-- ============================================================
-- 同樂學習入口：社群功能資料庫設定（Supabase）
-- 在 Supabase 的 SQL Editor 整段貼上執行即可，可重複執行。
-- 執行前請把最底下 admins 那行的信箱改成管理者的 Google 信箱。
-- ============================================================

-- 1) 使用者分享的作品 ------------------------------------------------
create table if not exists public.works (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  category    text not null default 'game' check (category in ('explore','game','teach')),
  url         text not null check (url ~* '^https?://'),
  tags        text[] not null default '{}',
  image_url   text,
  author_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 20),
  author_role text not null default 'guest' check (author_role in ('teacher','student','guest')),
  created_at  timestamptz not null default now()
);
-- 已建立過資料表的話，補上作者身分欄位（可重複執行）
alter table public.works add column if not exists author_role text not null default 'guest'
  check (author_role in ('teacher','student','guest'));

-- 2) 按讚：work_key 內建作品用代號（planet…），使用者作品為 'w:' || works.id
create table if not exists public.likes (
  work_key   text not null check (char_length(work_key) <= 80),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_key, user_id)
);

-- 3) 留言 ---------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  work_key    text not null check (char_length(work_key) <= 80),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 20),
  avatar_url  text,
  body        text not null check (char_length(body) between 1 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists comments_work_key_idx on public.comments (work_key, created_at);

-- 4) 管理者名單（只有 is_admin() 能讀，前端讀不到信箱）--------------------
create table if not exists public.admins (email text primary key);

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- 4b) 作品身分標示：由資料庫依登入信箱網域自動判斷，前端無法竄改
--     tmail.ilc.edu.tw → 教師作品；smail.ilc.edu.tw → 學生作品；管理者 → 教師作品；其他 → 訪客作品
create or replace function public.set_author_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if public.is_admin() or mail like '%@tmail.ilc.edu.tw' then
    new.author_role := 'teacher';
  elsif mail like '%@smail.ilc.edu.tw' then
    new.author_role := 'student';
  else
    new.author_role := 'guest';
  end if;
  return new;
end;
$$;
drop trigger if exists works_set_role on public.works;
create trigger works_set_role before insert on public.works
  for each row execute function public.set_author_role();

-- 5) 刪除作品時，連同按讚與留言一併清除 ------------------------------------
create or replace function public.cleanup_work()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.likes    where work_key = 'w:' || old.id::text;
  delete from public.comments where work_key = 'w:' || old.id::text;
  return old;
end;
$$;
drop trigger if exists works_cleanup on public.works;
create trigger works_cleanup after delete on public.works
  for each row execute function public.cleanup_work();

-- 6) 列級安全（RLS）：任何人可讀；登入者才能新增；只能刪自己的（管理者可刪全部）
alter table public.works    enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;
alter table public.admins   enable row level security;  -- 不建立任何 policy = 前端完全讀不到

drop policy if exists "works read"   on public.works;
drop policy if exists "works add"    on public.works;
drop policy if exists "works delete" on public.works;
create policy "works read"   on public.works for select using (true);
create policy "works add"    on public.works for insert to authenticated with check (author_id = auth.uid());
create policy "works delete" on public.works for delete to authenticated using (author_id = auth.uid() or public.is_admin());

drop policy if exists "likes read"   on public.likes;
drop policy if exists "likes add"    on public.likes;
drop policy if exists "likes delete" on public.likes;
create policy "likes read"   on public.likes for select using (true);
create policy "likes add"    on public.likes for insert to authenticated with check (user_id = auth.uid());
create policy "likes delete" on public.likes for delete to authenticated using (user_id = auth.uid());

drop policy if exists "comments read"   on public.comments;
drop policy if exists "comments add"    on public.comments;
drop policy if exists "comments delete" on public.comments;
create policy "comments read"   on public.comments for select using (true);
create policy "comments add"    on public.comments for insert to authenticated with check (user_id = auth.uid());
create policy "comments delete" on public.comments for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- 7) 作品封面圖的儲存空間（公開讀取、只能上傳到自己的資料夾、限 1 MB）-----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('work-covers', 'work-covers', true, 1048576, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists "work-covers read"   on storage.objects;
drop policy if exists "work-covers upload" on storage.objects;
drop policy if exists "work-covers delete" on storage.objects;
create policy "work-covers read" on storage.objects for select
  using (bucket_id = 'work-covers');
create policy "work-covers upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'work-covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "work-covers delete" on storage.objects for delete to authenticated
  using (bucket_id = 'work-covers' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- 8) 設定管理者（改成你的 Google 信箱後執行）---------------------------------
-- insert into public.admins (email) values ('你的信箱@gmail.com') on conflict do nothing;
