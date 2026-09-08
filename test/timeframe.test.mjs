import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become ready: ${stderr()}`);
}

function writeSession(file, timestamp, model = "claude-opus-5") {
  writeFileSync(file, JSON.stringify({
    type: "assistant",
    cwd: "/fixture",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      id: `msg_${timestamp}`,
      model,
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }) + "\n");
  const seconds = timestamp / 1_000;
  utimesSync(file, seconds, seconds);
}

test("the 5h option requests and returns an exact five-hour scan window", async () => {
  const appSource = readFileSync(join(PROJECT, "public", "app.js"), "utf8");
  assert.match(appSource, /\['5h','5h'/, "5h control is missing from TIMEFRAMES");
  assert.match(appSource, /\/api\?hours=/, "5h control does not request an hour-based API window");

  const work = mkdtempSync(join(tmpdir(), "claude-cost-5h-"));
  let child;
  try {
    const projectDir = join(work, ".claude", "projects", "fixture");
    mkdirSync(projectDir, { recursive: true });
    const now = Date.now();
    writeSession(join(projectDir, "recent.jsonl"), now - 60 * 60_000);
    const oldFile = join(projectDir, "old.jsonl");
    writeSession(oldFile, now - 6 * 60 * 60_000);
    // Simulate a harmless reindex/touch: file mtime is recent even though the
    // session's last real message is outside the requested five-hour window.
    // The API must filter by the row timestamp, not trust mtime alone.
    utimesSync(oldFile, now / 1_000, now / 1_000);
    const resumedFile = join(projectDir, "resumed.jsonl");
    writeSession(resumedFile, now - 6 * 60 * 60_000, "claude-fable-5");
    appendFileSync(resumedFile, JSON.stringify({
      type: "assistant",
      cwd: "/fixture",
      timestamp: new Date(now - 30 * 60_000).toISOString(),
      message: {
        id: "msg_resume_marker",
        model: "<synthetic>",
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }) + "\n");
    utimesSync(resumedFile, now / 1_000, now / 1_000);
    const serverFile = join(work, "server.mjs");
    copyFileSync(join(PROJECT, "server.mjs"), serverFile);
    const port = await freePort();
    let err = "";
    child = spawn(process.execPath, [serverFile], {
      env: { ...process.env, HOME: work, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const data = await waitForJson(`http://127.0.0.1:${port}/api?hours=5&raw=1`, child, () => err);

    assert.equal(data.windowHours, 5);
    assert.equal(data.windowDays, null);
    assert.deepEqual(data.sessions.map((row) => row.id), ["recent"]);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  }
});
