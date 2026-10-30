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

-- 7b) 作品點擊統計（含未登入訪客）--------------------------------------------
-- 每位訪客（瀏覽器內的匿名隨機代號）、每個作品、每天最多記一筆；不記 IP、姓名或信箱。
-- 資料表開啟 RLS 且不建立任何 policy：前端無法直接讀寫，只能透過下面三個函式。
create table if not exists public.clicks (
  id         bigint generated always as identity primary key,
  work_key   text not null check (work_key ~ '^(w:[0-9a-f-]{36}|[a-z0-9-]{1,40})$'),
  visitor    text not null check (char_length(visitor) between 8 and 64),
  day        date not null default ((now() at time zone 'Asia/Taipei')::date),
  role       text not null default 'guest' check (role in ('teacher','student','guest')),
  created_at timestamptz not null default now(),
  unique (work_key, visitor, day)
);
create index if not exists clicks_day_idx on public.clicks (day);
alter table public.clicks enable row level security;

-- 記錄一次開啟（任何人可呼叫，重複的會被忽略）；身分由登入信箱網域在資料庫端判斷
create or replace function public.track_click(p_key text, p_visitor text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  r text := 'guest';
begin
  if public.is_admin() or mail like '%@tmail.ilc.edu.tw' then r := 'teacher';
  elsif mail like '%@smail.ilc.edu.tw' then r := 'student';
  end if;
  insert into public.clicks (work_key, visitor, role) values (p_key, p_visitor, r)
  on conflict (work_key, visitor, day) do nothing;
end;
$$;

-- 各作品累計開啟次數（公開，只回傳總數）
create or replace function public.click_counts()
returns table (work_key text, total bigint)
language sql
security definer
set search_path = public
stable
as $$
  select c.work_key, count(*)::bigint from public.clicks c group by c.work_key;
$$;

-- 詳細統計（僅管理者）：依作品、身分、日期彙總
create or replace function public.click_stats(p_days int default 30)
returns table (work_key text, role text, day date, n bigint)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select c.work_key, c.role, c.day, count(*)::bigint
    from public.clicks c
    where c.day >= ((now() at time zone 'Asia/Taipei')::date - greatest(1, least(p_days, 365)) + 1)
    group by c.work_key, c.role, c.day;
end;
$$;

grant execute on function public.track_click(text, text) to anon, authenticated;
grant execute on function public.click_counts()           to anon, authenticated;
grant execute on function public.click_stats(int)         to authenticated;

-- 7c) 許願池（必須登入才讀得到；未登入者連資料表都看不到）----------------------
create table if not exists public.wishes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 20),
  avatar_url  text,
  body        text not null check (char_length(body) between 2 and 200),
  status      text not null default 'open' check (status in ('open','done')),
  created_at  timestamptz not null default now()
);
create index if not exists wishes_created_idx on public.wishes (created_at desc);

create table if not exists public.wish_votes (
  wish_id uuid not null references public.wishes(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (wish_id, user_id)
);

-- 防洗版：每人 24 小時內最多許 10 個願望
create or replace function public.wish_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.wishes where user_id = new.user_id and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'wish limit' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists wishes_limit on public.wishes;
create trigger wishes_limit before insert on public.wishes for each row execute function public.wish_limit();

alter table public.wishes     enable row level security;
alter table public.wish_votes enable row level security;
drop policy if exists "wishes read"   on public.wishes;
drop policy if exists "wishes add"    on public.wishes;
drop policy if exists "wishes status" on public.wishes;
drop policy if exists "wishes delete" on public.wishes;
create policy "wishes read"   on public.wishes for select to authenticated using (true);
create policy "wishes add"    on public.wishes for insert to authenticated with check (user_id = auth.uid() and status = 'open');
create policy "wishes status" on public.wishes for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "wishes delete" on public.wishes for delete to authenticated using (user_id = auth.uid() or public.is_admin());
-- 更新只開放 status 欄位（管理者標示「已實現」）
revoke update on public.wishes from authenticated, anon;
grant update (status) on public.wishes to authenticated;
revoke all on public.wishes, public.wish_votes from anon;

drop policy if exists "wish_votes read"   on public.wish_votes;
drop policy if exists "wish_votes add"    on public.wish_votes;
drop policy if exists "wish_votes delete" on public.wish_votes;
create policy "wish_votes read"   on public.wish_votes for select to authenticated using (true);
create policy "wish_votes add"    on public.wish_votes for insert to authenticated with check (user_id = auth.uid());
create policy "wish_votes delete" on public.wish_votes for delete to authenticated using (user_id = auth.uid());

-- 8) 設定管理者（改成你的 Google 信箱後執行）---------------------------------
-- insert into public.admins (email) values ('你的信箱@gmail.com') on conflict do nothing;
