# Crypto Terminal Cloud v1.0 — integrated release candidate

This package combines the legacy v1.12.4 terminal UI with a Cloudflare Worker API, same-origin Pages proxy, cloud client, and a migration payload generated from the full 15 Nov 2026 backup.

## Package map
- `pages/` — Pages deployment root (HTML, cloud client, Pages Function proxy)
- `worker/worker.js` — Worker candidate
- `worker/test-core.mjs` — backend accounting and authorization tests
- `frontend/cloud/` — cloud API client and tests
- `migration/` — migration generator, generated payload, and parity tests
- `docs/` — access model, API reference, migration report, integration notes
- `deploy/DEPLOY-CHECKLIST.md` — deployment requirements and cutover checklist

## Current implementation
- Cloud bootstrap happens before the dashboard initializes; it fails closed instead of silently loading a separate local-only portfolio copy.
- Spot buy/sell, wallet deposits/withdrawals/exchanges, manual position corrections, and dust cleanup are sent to typed server operations.
- Portfolio create/rename/archive are admin-only API actions. New portfolios do not automatically grant any other user access.
- Watchlist, Options, and saved strategies use permission-filtered shared cloud collections.
- Admin Panel supports user provisioning, block state, global feature grants, per-portfolio `view/history/trade/edit/funds` grants, admin role changes, and audit log viewing.
- User portfolio visibility is explicit per portfolio; server-side checks remain authoritative.


## Integrated feature update (local RC10 package)
- Options cash accounting is stored server-side in a dedicated ledger. Opening multi-leg strategies and closing positions commit wallet movements and both position collections atomically. Existing migrated positions are not charged retroactively; new BUY/SELL operations enforce available balance including fees.
- Guest Mode is a public market-only shell. Cloudflare Access must be configured with a public Pages document and a separately protected `/api/*` application; Worker JWT validation remains enabled.
- A daily `0 3 * * *` UTC Cron runs integrity checks and attempts a Binance-backed market snapshot. Unchanged prices skip GitHub commits.
- Analytics history keeps 30 days of raw observations, daily aggregation from 30 days to one year, and monthly aggregation older than one year. Aged daily aggregates roll into monthly buckets with weighted statistics.
- Asset Cost Basis is displayed in both portfolio overview cards; newly introduced UI labels are Ukrainian.

## Latest hardening (RC8)
- Clear all browser-cached shared collection keys before applying the current user's permission-filtered cloud collections. This prevents stale Watchlist/Options/strategy/analytics data from a previous account in the same browser from remaining visible when the next account lacks access.

- Backup export and saved-strategy export controls are now disabled for non-admin users unless the explicit global `exportData` permission is granted. This prevents a user from using the portable export UI without the designated export permission.

## Latest hardening (RC10)
- The admin migration dry-run now validates the exact transformed migration payload (schema/version, migration ID, unique portfolio IDs, names, state shape, transaction and adjustment bounds) and reports portfolio/transaction/position/collection counts without writing to GitHub.
- The endpoint still supports legacy-backup structure inspection, but clearly distinguishes that report from a transformed-payload readiness check.

## Previous hardening (RC6)
- Pending financial operations persist their idempotency key and original timestamp in tab-scoped session storage, so a page reload after an ambiguous network failure cannot accidentally submit the same trade or wallet operation with a new key. A confirmed success or replay clears the pending record.

## Previous hardening (RC5)
- Financial operation retries reuse the same idempotency key and timestamp after ambiguous transport failures.
- Shared collection saves refresh the server revision and retry the same partial patch once after a concurrent update.

## Latest hardening
- Admin wildcard permissions are handled correctly during bootstrap.
- Portfolio financial state is held in memory from the cloud response and is not written back to browser localStorage.
- State-only projection rows for users without `history` are excluded from the transaction journal; realized P/L remains sourced from cloud state.

## Known release blockers
- No live browser test has been run against the user's Cloudflare Pages Service Binding and private GitHub repository in this environment.
- The import endpoint has not been executed against the user's production private repository.
- The current legacy backup/restore UI is not a cloud import path; the import button is disabled in Cloud mode. Use the controlled admin migration endpoint only after review.
- Analytics history writes are admin-only; non-admin users receive filtered history based on their visible portfolio IDs and options permission.
- Before production cutover, follow `deploy/DEPLOY-CHECKLIST.md` and review the root `RELEASE-STATUS.md`.

## Local checks
```bash
node --check worker/worker.js
node --check frontend/cloud/cloud-client.js
node worker/test-core.mjs
node worker/test-worker-routes.mjs
node worker/test-import-integration.mjs
node frontend/cloud/test-cloud-client.mjs
node migration/test-migration.mjs /path/to/crypto-terminal-backup-2026-11-15T23-23-59-561Z.json
```
