-- Applied to the "Gilded Spines" Supabase project (ref daultyultrixmzqoyzfc).
-- One row per document a shelf keeps: a book, the settings, or an image.
-- Every row belongs to one account; row level security lets an account see
-- and change only its own.
create table public.docs (
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind      text not null check (kind in ('book', 'prefs', 'image')),
  id        text not null check (char_length(id) between 1 and 200),
  data      jsonb,
  rev       bigint not null default 0,          -- the writing device's clock, ms; newest wins
  deleted   boolean not null default false,     -- a deletion is kept so other devices learn of it
  synced_at timestamptz not null default clock_timestamp(),  -- server time, the pull cursor
  primary key (user_id, kind, id)
);
create index docs_user_synced on public.docs (user_id, synced_at);

alter table public.docs enable row level security;

create policy "own rows: read"   on public.docs for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.docs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.docs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.docs for delete to authenticated using ((select auth.uid()) = user_id);

-- Stamp every write with server time, and refuse a write older than what is
-- already stored, so a device that was offline cannot roll back a newer edit.
create function public.docs_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.rev < old.rev then
    return null;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;
