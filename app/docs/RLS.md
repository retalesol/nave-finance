# Row-Level Security Access Matrix

Every table has RLS enabled. The platform has no Supabase Auth login; browser
clients act as `anon` and pass the connected wallet via the `x-wallet-address`
header (a soft boundary). Server components (edge functions, signer) use the
`service_role` key, which bypasses RLS. The transparency model: public,
non-private DAO data is readable by anyone; all writes are service-role only;
personal data (watchlists) is wallet-scoped; agent keys are service-role only.

## Matrix

| Table | anon/authenticated read | anon/authenticated write | service_role |
| --- | --- | --- | --- |
| `dao_registry` | Public DAOs only (`privacy_enabled = false`) | none | full |
| `watched_daos` | Own rows (`x-wallet-address`) | insert/update/delete own rows | full |
| `encrypted_agent_keys` | none | none | read/insert/update (no delete) |
| `activity_logs` | Non-private DAOs | none | full |
| `treasury_snapshots` | Non-private DAOs | none | full |
| `monthly_reports` | Non-private DAOs | none | full |
| `agent_action_logs` | Non-private DAOs | none | full |
| `agent_sessions` | Non-private DAOs (added in 1780410000) | none | full |
| `signer_labels` | Public | none | full |
| `price_cache` | none | none | full |

## Notes

- `encrypted_agent_keys` is append-only by design: no DELETE policy for any
  role. Rotation inserts a new active row and marks the old one inactive.
- `agent_sessions` previously had RLS enabled with zero policies (default-deny),
  which broke the dashboard. It now mirrors `agent_action_logs`.
- `watched_daos` previously had conflicting policy sets; the permissive
  `using(true)` policies were dropped in 1780410000, leaving only the
  wallet-header-scoped model.
- Private DAOs (`privacy_enabled = true`) expose no public rows for activity,
  snapshots, reports, action logs, or sessions; only the service role can read
  them. Surface that data to authorized members through a service-mediated
  endpoint if/when per-member auth is added.
- The `x-wallet-address` header is not cryptographically verified. For
  high-value isolation, migrate to Supabase Auth or signed-wallet sessions and
  replace the header checks with `auth.jwt()`-based predicates.
