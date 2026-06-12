# 💸 claude-cost

A tiny, zero-dependency local dashboard that shows what every past **Claude Code** and **Codex** session would have cost you.

It scans your local session logs (`~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`), prices the token usage per model at API list prices, and serves a single-page dashboard.

![Plan mode](docs/plan-mode.png)

## Features

- 📦 **Plan pricing** (default) — see your subscription's effective rate. Pick your Anthropic plan (Pro / Max 5× / Max 20×) and OpenAI plan (Plus / Pro 5× / Pro 20×); every dollar figure is scaled by *plan price ÷ max possible monthly API spend*, so you see the plan-equivalent cost of your usage. Mode and plan choices are remembered (localStorage)
- 🧾 **API pricing** — one click away: raw input / output / cache-write / cache-read priced per model (Opus, Sonnet, Haiku, Fable, GPT-5.x, …)
- 🤖 Subagent/sidechain work is merged into its parent session and broken out as "subwork"
- 📊 Per-session drill-down: per-model token counts, spend by category (input / output / cache write / cache read / main / subworkers)
- 📈 **Spend-over-time chart** in the drill-down — cumulative raw-API $ across the session, subagent turns included (hover for the $ at any moment)
- ⚙️ **Workflow runs** (multi-agent orchestration under `subagents/workflows/`) fold into their mother session and show up as a `⚙ N workflow · 🤖×M` badge
- 🎯 Accurate Claude accounting: one API response is logged as many jsonl lines (same `message.id`, identical cache tokens, growing `output_tokens`) — usage is deduped per message id, otherwise cache costs inflate ~2×
- 🖥️ **Multi-machine** — optionally index other computers' session logs too: a gitignored `machines.local.mjs` declares extra log roots (e.g. rsync'd copies) and an optional background sync command; a 🌐 All / 💻 local / … header toggle switches between machines, and rows get a machine badge. All host names, paths, and sync scripts stay in the gitignored file
- ♨️ **Cache-warmth indicator** — sessions whose prompt cache is likely still alive get a ♨️ next to their timestamp (hover for details), so you know when resuming a session will reuse cached context. Anthropic's ~5-minute, refreshed-on-use TTL makes this predictable for Claude; OpenAI prefixes can survive 5–60 minutes but are evicted unpredictably, so Codex sessions get a best-guess ♨️/🌡️ instead of a promise. Updates live every 30 s
- 🔍 Live project filter — totals cards recompute over the filtered rows
- ↕️ Sortable columns, duration, cache-hit share
- ⚡ mtime-cached scanning, so multi-GB log directories stay fast after the first load
- 🔗 Shareable URL params override the saved state: `?mode=api|plan&claude=<plan>&codex=<plan>&machine=<id|all>&expand=<n>`

| API mode | Session drill-down |
|---|---|
| ![API mode](docs/api-mode.png) | ![Session detail](docs/session-detail.png) |

## Run

Works on Linux, macOS, and Windows — logs are read from `~/.claude/projects` and `~/.codex/sessions` under your home directory (`%USERPROFILE%` on Windows), which is where Claude Code and Codex put them on every OS. Timestamps render in your browser's time zone (`?tz=Area/City` to override).

```sh
node server.mjs            # → http://localhost:8799
PORT=9000 node server.mjs  # bash/zsh
```

```powershell
$env:PORT=9000; node server.mjs   # Windows PowerShell
```

No dependencies, no build step — one file, Node ≥ 18.

### Autostart

**Linux (systemd user service):**

```ini
# ~/.config/systemd/user/claude-cost.service
[Unit]
Description=claude-cost dashboard

[Service]
ExecStart=/usr/bin/node %h/claude-cost/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now claude-cost.service
```

**macOS (launchd):** save as `~/Library/LaunchAgents/com.claude-cost.plist`, then `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-cost</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/claude-cost/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

**Windows:** Task Scheduler → "At log on" → `node C:\path\to\claude-cost\server.mjs`, or any process manager you already use (e.g. `pm2 start server.mjs`).

## Plan-mode math

Plan mode answers: *"what did this usage effectively cost me at my plan's best-case rate?"*

| Plan | Price | Max possible spend (approx.) | Multiplier |
|---|---|---|---|
| claude-pro | $20/mo | $400/mo | ×0.05 |
| claude-max-5x | $100/mo | $2,000/mo | ×0.05 |
| claude-max-20x | $200/mo | $8,000/mo | ×0.025 |
| chatgpt-plus | $20/mo | $700/mo | ×0.0286 |
| chatgpt-pro-5x | $100/mo | $3,500/mo | ×0.0286 |
| chatgpt-pro-20x | $200/mo | $14,000/mo | ×0.0143 |

It's a lower bound implied by the max-spend column, not what you'd actually be billed.

## Privacy

Everything runs locally and reads only your own log files. Nothing leaves your machine — keep it bound to localhost.

## License

MIT
