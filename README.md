# 💸 claude-cost

A local dashboard for Claude Code, Codex, and configured direct-API usage ledgers.
It reads session logs, estimates token costs, and compares recorded spend with observed
subscription quotas. The server binds to `127.0.0.1`.

## Run

Requires Node.js 22 or newer. React, React DOM and htm are bundled locally: no npm
installation, build step, or browser CDN is required.

```sh
git clone https://github.com/ibmua/claude-cost.git "$HOME/claude-cost"
node "$HOME/claude-cost/server.mjs"
```

Open http://localhost:8799/ for Classic, or
http://localhost:8799/?view=studio&empty=1&panel=history for Usage desk with history.
Set `PORT` to choose a different local port. Logs default to `~/.claude/projects`
and `~/.codex/sessions`; additional `~/.claude-*` account directories are discovered.
The optional quota sampler requires Python 3.9+ and a POSIX platform (`fcntl`).

## Interface

- **Usage desk:** compact React interface with persistent dark/light theme, sessions,
  model spend, account limits, plans/prices, and history. Classic shares its data and filters.
- **History:** hourly/daily API spend stacked by model, plus separate Claude and Codex
  quota charts. Hover readouts sit below the plots; keyboard navigation, pinning and
  zoom keep inspection accessible. Missing observations and resets remain visible gaps.
- **Filters:** provider, machine, account, model, project and time window. Empty/error
  attempts can be included with `?empty=1`; they remain visible even with no token cost.
- **Session detail:** model/category costs, cumulative spend, subagent/workflow activity,
  token counts, session names, and local transcript actions. Batch ledgers load individual
  call details on demand.
- **Accounting:** deduplicated Claude messages, per-turn Codex models, real rolling
  five-hour slices, and cached scanning. History caches unchanged row contributions while
  additions, corrections and removals remain live.

Quota is account-wide. Task/model filters narrow cost, while provider/account scope controls
quota. Historical API dollars come from recorded dated calls; missing history is never
estimated from session totals. History calendar days use Europe/Kyiv; session timestamps
use the browser timezone unless overridden with `?tz=Area/City`.

## Plan-mode estimates

API mode uses token-category prices. Plan mode scales those dollars by
**monthly plan price ÷ estimated monthly API-equivalent allowance**, with the existing
Claude monthly cap applied. These are configurable accounting estimates, not an official
fixed API credit entitlement, invoice, or measurement of remaining quota.

| Plan ID | Monthly price | Estimated API-equivalent allowance | Multiplier |
|---|---:|---:|---:|
| `claude-pro` | $20 | $300 | ×0.0667 |
| `claude-max-5x` | $100 | $1,500 | ×0.0667 |
| `claude-max-20x` | $200 | $6,000 | ×0.0333 |
| `chatgpt-plus` | $20 | $350 | ×0.0571 |
| `chatgpt-pro-5x` | $100 | $1,750 | ×0.0571 |
| `chatgpt-pro-20x` | $200 | $7,000 | ×0.0286 |

`PLANS` in `public/app.js` is canonical; this table mirrors it. Current defaults were
recalibrated on 2026-09-08. Browser preferences store plan IDs, so reload adopts rate changes.
Live quota percentages come from provider usage endpoints independently of this conversion.

## How it works

| File | Owns |
|---|---|
| `server.mjs` | HTTP shell/API, Claude/Codex/ledger scanners, model API rates, scan cache, remote agent mode, local Claude quota observations |
| `public/app.js` | Shared React state, requests, filters, plan conversion, session expansion and virtualization |
| `public/components.js` | Shared totals, model/price/limit panels and session presentation |
| `public/studio.js`, `public/studio.css` | Usage desk layout and theme |
| `public/history.js` | Row/contribution caches, temporal aggregation and cost/quota charts |
| `quota_history.py` | Optional read-only Claude/Codex quota sampler and history reader |
| `vendor/` | Browser libraries and upstream licenses |
| `test/` | Synthetic scanner, pricing, timeframe, history and quota regressions |

Main read endpoints are `/api`, `/api/usage`, `/api/quota-history` and
`/api/ledger-calls`. Runtime caches, names and quota observations live under ignored `local/`.

## Private configuration

Create an ignored `machines.local.mjs` beside the server for additional sources. For example:

```js
export const local = {
  claudeUsageLedgers: [
    {path: '/absolute/path/to/usage.jsonl', label: 'Batch jobs',
     supplementalEmptyProviders: ['codex']},
  ],
};
export const machines = [{
  id: 'worker', label: '🖥 worker',
  remote: {host: 'worker-ssh-alias', dir: '/absolute/remote/collector'},
  claudeRoots: [{dir: '/absolute/remote/.claude', root: '/absolute/remote/.claude/projects'}],
  codexRoots: ['/absolute/remote/.codex/sessions'],
}];
```

Remote collection copies the same server file over SSH and runs `--agent` on the
machine that owns the transcripts. Only summaries return; transcripts are not mirrored.
A remote must have Node installed and an existing working SSH configuration.
Additional per-call OpenCode ledgers can be configured with `ocgoLedgers`.
Supplemental Codex ledger rows add only failed/empty attempts, avoiding duplicate native usage.

Claude quota collection uses existing credentials in discovered account directories;
`CLAUDE_COST_CRED_DIRS` overrides that list (colon-separated paths). The running dashboard
polls periodically, applies rate-limit backoff, and retains normalized local observations.
It does not refresh credentials or make model calls. Stale last-good readings are labelled.

For optional Codex or remote quota history, put a JSON config under `local/`:

```json
{
  "machine": "worker",
  "history": "/absolute/private/quota-history.jsonl",
  "sources": [
    {"id": "codex-primary", "provider": "codex", "auth": "/absolute/private/.codex/auth.json"}
  ]
}
```

Schedule `python3 /absolute/path/to/quota_history.py --config /absolute/private/config.json`
with your local scheduler. Successful observations are retained once per source/hour;
failures can retry. Add `quotaHistory: {script: '/absolute/path/to/quota_history.py',
config: '/absolute/private/config.json'}` to the corresponding machine entry so the
dashboard reads its history. The sampler/config must already exist on that machine.
`--history` reads stored samples without querying a provider.

## Privacy and publication

This repository contains code and synthetic tests. Account names, credentials, machine
configuration, logs, caches, deployment scripts and real-data screenshots belong in ignored
local files. Previously published screenshots are removed from the current tree; old commits
may still contain them. This release does not rewrite Git history.

The dashboard reads private transcripts and may show project paths and account labels.
It makes authenticated, read-only requests to Anthropic for account/quota data; the optional
sampler also queries ChatGPT usage. Configured remote collection uses SSH. Browser assets are
served locally. Do not expose this unauthenticated dashboard to the public internet.

## Tests

```sh
node --test "$HOME/claude-cost/test/"*.test.mjs
python3 "$HOME/claude-cost/test/quota_history_test.py"
```

The fixtures use temporary homes and synthetic records; they do not need real credentials.

## License

Project code: MIT. Vendored React/React DOM: MIT. Vendored htm: Apache-2.0.
See `LICENSE` and the license files in `vendor/`.
