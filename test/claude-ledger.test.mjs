import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForJson(url, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not answer: ${stderr()}`);
}

test("configured usage ledger preserves Claude calls and supplements empty Codex attempts only", async () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-ledger-"));
  let child;
  try {
    mkdirSync(join(work, "local"));
    const ledger = join(work, "usage.jsonl");
    const now = Date.now();
    const line = (minutesAgo, slug, usage) => JSON.stringify({
      tag: "sweep-test",
      slug,
      pass: 1,
      attempt: 1,
      provider: "claude",
      model: "claude-sonnet-5",
      usage,
      ts: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    const codexLine = (minutesAgo, slug, usage) => JSON.stringify({
      tag: "codex-sweep-test",
      slug,
      pass: 1,
      attempt: 1,
      provider: "codex",
      model: "gpt-5.6-luna",
      usage,
      ts: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    writeFileSync(ledger, [
      line(30, "alpha", {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
        output_tokens_details: { thinking_tokens: 50 },
      }),
      line(20, "beta", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      codexLine(10, "gamma-empty", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      codexLine(5, "delta-native-session-owns-success", {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 30,
      }),
      line(400, "outside-window", { input_tokens: 9_999, output_tokens: 0 }),
    ].join("\n") + "\n");

    copyFileSync(join(PROJECT, "server.mjs"), join(work, "server.mjs"));
    writeFileSync(join(work, "machines.local.mjs"), `export const local = {
      claudeUsageLedgers: [{
        path: ${JSON.stringify(ledger)},
        label: "fixture authoring",
        cwd: "/fixture/content",
        account: "fixture-account",
        defaultModel: "claude-fable-5",
        supplementalEmptyProviders: ["codex"]
      }]
    };\n`);
    const port = await freePort();
    let err = "";
    child = spawn(process.execPath, [join(work, "server.mjs")], {
      env: { ...process.env, HOME: work, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { err += chunk; });

    const data = await waitForJson(`http://127.0.0.1:${port}/api?hours=5&empty=1&raw=1`, child, () => err);
    const rows = data.sessions.filter((row) => row.ledgerLabel === "fixture authoring");
    assert.equal(rows.length, 2);
    const claudeRow = rows.find((row) => row.source === "claude");
    assert.equal(claudeRow.batchTag, "sweep-test");
    assert.equal(claudeRow.account, "fixture-account");
    assert.equal(claudeRow.msgs, 2);
    assert.equal(claudeRow.callCount, 2);
    assert.equal(claudeRow.emptyCallCount, 1);
    assert.equal(claudeRow.entityCount, 2);
    assert.equal(claudeRow.tokens, 1_000);
    assert.equal(claudeRow.breakdown[0].outR, 50);
    assert.equal(claudeRow.empty, false);

    const codexRow = rows.find((row) => row.source === "codex");
    assert.equal(codexRow.batchTag, "codex-sweep-test");
    assert.equal(codexRow.account, null);
    assert.equal(codexRow.callCount, 1);
    assert.equal(codexRow.emptyCallCount, 1);
    assert.equal(codexRow.entityCount, 1);
    assert.equal(codexRow.tokens, 0);
    assert.equal(codexRow.empty, true);

    const detail = await waitForJson(
      `http://127.0.0.1:${port}/api/ledger-calls?id=${encodeURIComponent(claudeRow.id)}&after=${data.windowCutoff}`,
      child,
      () => err,
    );
    assert.equal(detail.id, claudeRow.id);
    assert.equal(detail.calls.length, 2);
    assert.deepEqual(detail.calls.map((call) => call.slug), ["beta", "alpha"]);
    assert.equal(detail.calls[0].empty, true);
    assert.equal(detail.calls[1].empty, false);
    assert.equal(detail.calls[1].tokens, 1_000);
    assert.equal(detail.calls[1].cost.out, 0.003);
    assert.equal(detail.calls[1].cost.total, 0.004545);

    const codexDetail = await waitForJson(
      `http://127.0.0.1:${port}/api/ledger-calls?id=${encodeURIComponent(codexRow.id)}&after=${data.windowCutoff}`,
      child,
      () => err,
    );
    assert.deepEqual(codexDetail.calls.map((call) => call.slug), ["gamma-empty"]);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  }
});
