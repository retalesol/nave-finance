-- Monthly treasury reports
-- Queried by: useMonthlyReports hook
-- Populated by: snapshot-treasury edge function / manual indexer

create table if not exists public.monthly_reports (
  id uuid primary key default gen_random_uuid(),
  dao_onchain_address text not null,
  year integer not null,
  month integer not null check (month >= 1 and month <= 12),
  capital_start numeric not null default 0,
  capital_end numeric not null default 0,
  yield_earned numeric not null default 0,
  fees_collected numeric not null default 0,
  agent_actions_count integer not null default 0,
  wallet_actions_count integer not null default 0,
  proposals_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- One report per DAO per month
  constraint monthly_reports_unique unique (dao_onchain_address, year, month)
);

-- Index for efficient lookups by DAO
create index if not exists idx_monthly_reports_dao
  on public.monthly_reports (dao_onchain_address, year desc, month desc);

-- RLS: read-only for authenticated users, insert/update via service role only
alter table public.monthly_reports enable row level security;

create policy "Anyone can read monthly reports"
  on public.monthly_reports for select
  using (true);
