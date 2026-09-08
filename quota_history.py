#!/usr/bin/env python3
"""Read-only subscription snapshots. No inference, token refresh, or credential output."""
import argparse
import base64
import fcntl
import json
import math
import os
from pathlib import Path
import time
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(url, token, extra=None):
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json", "User-Agent": "claude-cost-quota/1"}
    headers.update(extra or {})
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, headers=headers), timeout=25) as r:
        return json.load(r)


def window(key, label, used, reset):
    if not isinstance(used, (int, float)) or not math.isfinite(used):
        return None
    return dict(key=key, label=label, used=used, remaining=max(0, min(100, 100-used)), resets=reset)


def claude_windows(data):
    result = []
    for item in data.get("limits") or []:
        scope = item.get("scope") or {}
        model = scope.get("model") or {}
        model = model.get("display_name", "") if isinstance(model, dict) else str(model)
        kind = item.get("kind", "unknown")
        key = kind + (":" + model if model else "")
        label = {"session": "5-hour", "weekly_all": "Weekly · all", "weekly_scoped": "Weekly · " + (model or "scoped")}.get(kind, key)
        result.append(window(key, label, item.get("percent"), item.get("resets_at")))
    if not result:
        for key, value in data.items():
            if key == "five_hour" or key.startswith("seven_day"):
                if isinstance(value, dict):
                    result.append(window(key, key.replace("_", " "), value.get("utilization"), value.get("resets_at")))
    return [w for w in result if w]


def codex_windows(data):
    result = []
    groups = [("codex", data.get("rate_limit") or {})]
    for item in data.get("additional_rate_limits") or []:
        groups.append((item.get("limit_name") or item.get("metered_feature") or "additional", item.get("rate_limit") or {}))
    for name, group in groups:
        for key in ("primary_window", "secondary_window"):
            value = group.get(key) or {}
            seconds = value.get("limit_window_seconds")
            label = "Weekly" if seconds == 604800 else (str(seconds / 3600).removesuffix(".0") + "h") if seconds else key.replace("_window", "")
            result.append(window(name+":"+key, name+" · "+label, value.get("used_percent"), value.get("reset_at")))
    return [w for w in result if w]


def probe(source):
    provider = source["provider"]
    auth = json.loads(Path(source["auth"]).read_text())
    if provider == "claude":
        token = (auth.get("claudeAiOauth") or {}).get("accessToken")
        if not token:
            raise ValueError("logged out")
        headers = {"anthropic-beta": "oauth-2025-04-20"}
        profile = get("https://api.anthropic.com/api/oauth/profile", token, headers)
        account = profile.get("account") or {}
        data = get("https://api.anthropic.com/api/oauth/usage", token, headers)
        return dict(accountId=account.get("uuid") or account.get("email"), account=(account.get("email") or source["id"]).split("@")[0], windows=claude_windows(data))
    if provider == "codex":
        tokens = auth.get("tokens") or {}
        token = tokens.get("access_token")
        if not token:
            raise ValueError("no subscription token")
        headers = {"ChatGPT-Account-Id": tokens["account_id"]} if tokens.get("account_id") else {}
        data = get("https://chatgpt.com/backend-api/wham/usage", token, headers)
        email = ""
        try:
            part = (tokens.get("id_token") or token).split(".")[1]
            email = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email", "")
        except (ValueError, IndexError):
            pass
        return dict(accountId=tokens.get("account_id") or source["id"], account=email.split("@")[0] or source["id"], windows=codex_windows(data))
    raise ValueError("unsupported provider")


def read_history(path, after=0):
    rows = []
    if Path(path).exists():
        with open(path) as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if row["ts"] >= after:
                        rows.append(row)
                except (ValueError, KeyError):
                    continue
    return rows


def snapshot(config):
    path = Path(config["history"])
    path.parent.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    with open(str(path)+".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = time.time()*1000
        hour = int(now // 3600000)
        done = {r["sourceId"] for r in read_history(path, hour*3600000) if r.get("status") == "ok"}
        seen = set()
        records = []
        for source in config["sources"]:
            if source["id"] in done:
                continue
            real = str(Path(source["auth"]).resolve())
            if real in seen:
                continue
            seen.add(real)
            row = dict(ts=int(time.time()*1000), at=datetime.now(ZoneInfo("Europe/Kyiv")).isoformat(), machine=config["machine"], sourceId=source["id"], provider=source["provider"])
            try:
                result = probe(source)
                if not result["windows"]:
                    raise ValueError("no quota windows returned")
                row.update(result, status="ok")
            except Exception as error:
                # Never retain response bodies, authorization headers, or tokens.
                row.update(status="error", error=("HTTP " + str(error.code)) if hasattr(error, "code") else type(error).__name__, windows=[])
            with path.open("a") as stream:
                stream.write(json.dumps(row, separators=(",", ":"))+"\n")
                stream.flush()
                os.fsync(stream.fileno())
            records.append(row)
        print(json.dumps({"recorded": len(records), "sources": [{"id":r["sourceId"], "status":r["status"], "error":r.get("error"), "windows":len(r["windows"])} for r in records]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--after", type=float, default=0)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if args.history:
        print(json.dumps(read_history(config["history"], args.after), separators=(",", ":")))
    else:
        snapshot(config)
