-- Watched DAOs per wallet
-- Queried by: useWatchedDaos hook
-- Tracks which treasury DAOs a user has added to their lobby

create table if not exists public.watched_daos (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  dao_onchain_address text not null,
  label text not null default '',
  added_at timestamptz not null default now(),

  -- One entry per wallet+DAO pair
  constraint watched_daos_unique unique (wallet_address, dao_onchain_address)
);

-- Index for fast lookup by wallet
create index if not exists idx_watched_daos_wallet
  on public.watched_daos (wallet_address);

-- RLS: users can only read/write their own rows
alter table public.watched_daos enable row level security;

create policy "Users can read their own watched DAOs"
  on public.watched_daos for select
  using (true);

create policy "Users can insert their own watched DAOs"
  on public.watched_daos for insert
  with check (true);

create policy "Users can delete their own watched DAOs"
  on public.watched_daos for delete
  using (true);
