import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));

test("current and future Claude Opus sessions receive category and total cost estimates", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-opus5-"));
  try {
    const root = join(work, "projects");
    const sessionDir = join(root, "fixture");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "opus5.jsonl"), JSON.stringify({
      type: "assistant",
      cwd: "/fixture",
      timestamp: "2026-08-31T06:00:00.000Z",
      message: {
        id: "msg_fixture",
        model: "claude-opus-5",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 2_000,
          cache_creation_input_tokens: 3_000,
          cache_read_input_tokens: 4_000,
        },
      },
    }) + "\n");
    appendFileSync(join(sessionDir, "opus5.jsonl"), JSON.stringify({
      type: "assistant",
      cwd: "/fixture",
      timestamp: "2026-08-31T06:00:01.000Z",
      message: {
        id: "msg_synthetic",
        model: "<synthetic>",
        content: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }) + "\n");
    writeFileSync(join(sessionDir, "future-opus.jsonl"), JSON.stringify({
      type: "assistant",
      cwd: "/fixture",
      timestamp: "2026-08-31T06:01:00.000Z",
      message: {
        id: "msg_future",
        model: "claude-opus-99",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 2_000,
          cache_creation_input_tokens: 3_000,
          cache_read_input_tokens: 4_000,
        },
      },
    }) + "\n");

    const server = join(work, "server.mjs");
    copyFileSync(join(PROJECT, "server.mjs"), server);
    const opusFile = join(sessionDir, "opus5.jsonl");
    const staleRow = {
      id: "opus5",
      cwd: "opus-5 /fixture",
      first: "2026-08-31T06:00:00.000Z",
      last: "2026-08-31T06:00:01.000Z",
      msgs: 2,
      usd: 0,
      tokens: 10_000,
      unpriced: true,
      series: [],
      mainModels: ["claude-opus-5"],
      breakdown: [{
        model: "claude-opus-5",
        in: 1_000,
        out: 2_000,
        cw: 3_000,
        cr: 4_000,
        usd: 0,
        main: 0,
        sub: 0,
        outR: 0,
        rEst: true,
      }],
      lane: { main: 0, sub: 0 },
      cat: { in: 0, out: 0, cw: 0, cr: 0 },
      realCwd: "/fixture",
    };
    mkdirSync(join(work, "local"));
    writeFileSync(join(work, "local", "scan-cache.json"), JSON.stringify({
      [opusFile]: { m: statSync(opusFile).mtimeMs, j: JSON.stringify(staleRow) },
    }));
    const config = Buffer.from(JSON.stringify({
      compact: false,
      machine: {
        id: "fixture",
        claudeRoots: [{ root, account: "fixture" }],
        codexRoots: [],
      },
    })).toString("base64");
    const run = spawnSync(process.execPath, [server, "--agent"], {
      encoding: "utf8",
      env: { ...process.env, HOME: work, CC_AGENT_B64: config },
    });

    assert.equal(run.status, 0, run.stderr);
    const rows = JSON.parse(run.stdout);
    assert.equal(rows.length, 2);
    const byModel = new Map(rows.map((row) => [row.breakdown[0].model, row]));
    for (const model of ["claude-opus-5", "claude-opus-99"]) {
      const row = byModel.get(model);
      assert.ok(row, `missing ${model} fixture row`);
      assert.equal(row.unpriced, false);
      assert.deepEqual(row.cat, {
        in: 0.005,
        out: 0.05,
        cw: 0.01875,
        cr: 0.002,
      });
      assert.equal(row.usd, 0.07575);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Fable 5.1 uses its reduced cache-read rate without repricing Fable 5 history", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-fable51-"));
  try {
    const root = join(work, "projects");
    const sessionDir = join(root, "fixture");
    mkdirSync(sessionDir, { recursive: true });
    for (const model of ["claude-fable-5", "claude-fable-5-1"]) {
      writeFileSync(join(sessionDir, `${model}.jsonl`), JSON.stringify({
        type: "assistant",
        cwd: "/fixture",
        timestamp: "2026-09-02T06:00:00.000Z",
        message: {
          id: `msg_${model}`,
          model,
          content: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 1_000,
            output_tokens: 2_000,
            cache_creation_input_tokens: 3_000,
            cache_read_input_tokens: 4_000,
          },
        },
      }) + "\n");
    }

    const server = join(work, "server.mjs");
    copyFileSync(join(PROJECT, "server.mjs"), server);
    const config = Buffer.from(JSON.stringify({
      compact: false,
      machine: {
        id: "fixture",
        claudeRoots: [{ root, account: "fixture" }],
        codexRoots: [],
      },
    })).toString("base64");
    const run = spawnSync(process.execPath, [server, "--agent"], {
      encoding: "utf8",
      env: { ...process.env, HOME: work, CC_AGENT_B64: config },
    });

    assert.equal(run.status, 0, run.stderr);
    const rows = JSON.parse(run.stdout);
    const byModel = new Map(rows.map((row) => [row.breakdown[0].model, row]));
    assert.deepEqual(byModel.get("claude-fable-5").cat, {
      in: 0.01,
      out: 0.1,
      cw: 0.0375,
      cr: 0.004,
    });
    assert.equal(byModel.get("claude-fable-5").usd, 0.1515);
    assert.deepEqual(byModel.get("claude-fable-5-1").cat, {
      in: 0.01,
      out: 0.1,
      cw: 0.0375,
      cr: 0.001,
    });
    assert.equal(byModel.get("claude-fable-5-1").usd, 0.1485);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("GPT-5.6 Codex sessions use the current Sol, Terra, and Luna rates", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-gpt56-"));
  try {
    const codexRoot = join(work, "codex-sessions");
    mkdirSync(codexRoot, { recursive: true });
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const file = join(codexRoot, `${model}.jsonl`);
      writeFileSync(file, [
        {
          timestamp: "2026-09-02T06:00:00.000Z",
          type: "session_meta",
          payload: { id: `session_${model}`, cwd: "/fixture" },
        },
        {
          timestamp: "2026-09-02T06:00:01.000Z",
          type: "turn_context",
          payload: { model },
        },
        {
          timestamp: "2026-09-02T06:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 400,
                output_tokens: 2_000,
                reasoning_output_tokens: 500,
              },
              last_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 400,
                output_tokens: 2_000,
                reasoning_output_tokens: 500,
              },
            },
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    }

    const server = join(work, "server.mjs");
    copyFileSync(join(PROJECT, "server.mjs"), server);
    const config = Buffer.from(JSON.stringify({
      compact: false,
      machine: {
        id: "fixture",
        claudeRoots: [],
        codexRoots: [codexRoot],
      },
    })).toString("base64");
    const run = spawnSync(process.execPath, [server, "--agent"], {
      encoding: "utf8",
      env: { ...process.env, HOME: work, CC_AGENT_B64: config },
    });

    assert.equal(run.status, 0, run.stderr);
    const rows = JSON.parse(run.stdout);
    const byModel = new Map(rows.map((row) => [row.breakdown[0].model, row]));
    assert.deepEqual(byModel.get("gpt-6-astra").cat, { in: 0.006, out: 0.1, cw: 0, cr: 0.0004 });
    assert.equal(byModel.get("gpt-6-astra").unpriced, false);
    assert.deepEqual(byModel.get("gpt-5.6-sol").cat, {
      in: 0.0024,
      out: 0.04,
      cw: 0,
      cr: 0.00016,
    });
    assert.equal(byModel.get("gpt-5.6-sol").usd, 0.04256);
    assert.deepEqual(byModel.get("gpt-5.6-terra").cat, {
      in: 0.0012,
      out: 0.024,
      cw: 0,
      cr: 0.00008,
    });
    assert.equal(byModel.get("gpt-5.6-terra").usd, 0.02528);
    assert.deepEqual(byModel.get("gpt-5.6-luna").cat, {
      in: 0.00012,
      out: 0.0024,
      cw: 0,
      cr: 0.000008,
    });
    assert.equal(byModel.get("gpt-5.6-luna").usd, 0.002528);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("OpenCode Go collects multiple ledgers and keeps same-second request retries", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-ocgo-ledgers-"));
  try {
    const one = join(work, "batch-a.jsonl");
    const two = join(work, "batch-b.jsonl");
    const base = {
      ts: 1788469200, arm: "muse-smoke", slug: "zany-face",
      model: "muse-spark-1.3-contributor", prompt_tokens: 100,
      completion_tokens: 20, cached_tokens: 10, reasoning_tokens: 2,
      status: "ok",
    };
    writeFileSync(one, JSON.stringify({ ...base, request_id: "request-a" }) + "\n");
    writeFileSync(two, [
      JSON.stringify({ ...base, request_id: "request-b", provider: "opencode",
                       model: "muse-spark-1.3-contributor-free" }),
      JSON.stringify({ ...base, request_id: "request-c", status: "empty",
                       prompt_tokens: 0, completion_tokens: 0 }),
    ].join("\n") + "\n");

    const server = join(work, "server.mjs");
    copyFileSync(join(PROJECT, "server.mjs"), server);
    const config = Buffer.from(JSON.stringify({
      compact: false,
      machine: { id: "fixture", claudeRoots: [], codexRoots: [], ocgoLedgers: [one, two] },
    })).toString("base64");
    const run = spawnSync(process.execPath, [server, "--agent"], {
      encoding: "utf8",
      env: { ...process.env, HOME: work, CC_AGENT_B64: config },
    });

    assert.equal(run.status, 0, run.stderr);
    const rows = JSON.parse(run.stdout);
    assert.equal(rows.length, 3);
    assert.deepEqual(new Set(rows.map((row) => row.id)),
                     new Set(["request-a", "request-b", "request-c"]));
    assert.equal(rows.filter((row) => row.empty).length, 1);
    const zen = rows.find((row) => row.id === "request-b");
    assert.equal(zen.cwd, "opencode/muse-spark-1.3-contributor-free");
    assert.equal(zen.realCwd, "opencode/muse-smoke");
    assert.equal(zen.account, "opencode");
    assert.equal(zen.usd, 0);
    assert.equal(zen.unpriced, false);
    const go = rows.find(row => row.id === "request-a");
    assert.equal(go.unpriced, false);
    assert.deepEqual(go.cat, { in: 0.000009, out: 0.000004, cw: 0, cr: 0.00000002 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Codex model switches retain each call's model, price and reasoning", () => {
 const work=mkdtempSync(join(tmpdir(),'claude-cost-switch-'));
 try{
  const root=join(work,'sessions');mkdirSync(root);
  const events=[{type:'session_meta',payload:{id:'switch',cwd:'/fixture'}},...['gpt-5.6-luna','gpt-6-astra'].flatMap(model=>[
   {type:'turn_context',payload:{model}},
   {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{},last_token_usage:{input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_output_tokens:50}}}}
  ])];
  writeFileSync(join(root,'switch.jsonl'),events.map((r,i)=>JSON.stringify({timestamp:`2026-09-07T20:00:0${i}+03:00`,...r})).join('\n')+'\n');
  const server=join(work,'server.mjs');copyFileSync(join(PROJECT,'server.mjs'),server);
  const cfg=Buffer.from(JSON.stringify({compact:false,machine:{id:'fixture',claudeRoots:[],codexRoots:[root]}})).toString('base64');
  const run=spawnSync(process.execPath,[server,'--agent'],{encoding:'utf8',env:{...process.env,HOME:work,CC_AGENT_B64:cfg}});
  assert.equal(run.status,0,run.stderr);const [row]=JSON.parse(run.stdout);
  assert.deepEqual(row.mainModels,['gpt-5.6-luna','gpt-6-astra']);
  assert.deepEqual(row.series.map(p=>p[2]),row.mainModels);
  assert.ok(Math.abs(row.series[0][1]-.00032)<1e-12);
  assert.ok(Math.abs(row.series[1][1]-.015)<1e-12);
  assert.equal(row.breakdown[0].outR,50);assert.equal(row.breakdown[1].outR,50);
  assert.ok(Math.abs(row.usd-row.series.reduce((n,p)=>n+p[1],0))<1e-12);
 }finally{rmSync(work,{recursive:true,force:true});}
});

test("Astra tiers are applied per request and agree with the spend chart", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-astra-tier-"));
  try {
    const root = join(work, "sessions"); mkdirSync(root);
    const rows = [
      { type: "session_meta", payload: { id: "astra-tiers", cwd: "/fixture" } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      ...[272000, 272001].map(input_tokens => ({ type: "event_msg", payload: {
        type: "token_count", info: { total_token_usage: {}, last_token_usage: {
          input_tokens, cached_input_tokens: 100000, output_tokens: 1000,
        } },
      } })),
    ];
    writeFileSync(join(root, "astra.jsonl"), rows.map((r, i) => JSON.stringify({
      timestamp: `2026-09-06T20:00:0${i}+03:00`, ...r,
    })).join("\n") + "\n");
    const server = join(work, "server.mjs"); copyFileSync(join(PROJECT, "server.mjs"), server);
    const config = Buffer.from(JSON.stringify({ compact: false, machine: {
      id: "fixture", claudeRoots: [], codexRoots: [root],
    } })).toString("base64");
    const run = spawnSync(process.execPath, [server, "--agent"], {
      encoding: "utf8", env: { ...process.env, HOME: work, CC_AGENT_B64: config },
    });
    assert.equal(run.status, 0, run.stderr);
    const [row] = JSON.parse(run.stdout);
    assert.ok(Math.abs(row.cat.in - 5.16002) < 1e-10);
    assert.ok(Math.abs(row.cat.cr - 0.3) < 1e-10);
    assert.equal(row.cat.out, 0.125);
    assert.ok(Math.abs(row.usd - 5.58502) < 1e-10);
    assert.ok(Math.abs(row.series.reduce((n, x) => n + x[1], 0) - row.usd) < 1e-10);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("direct Codex Responses ledger retains Astra identity, pricing and empty attempts", () => {
  const work = mkdtempSync(join(tmpdir(), "claude-cost-direct-codex-"));
  try {
    const ledger = join(work, "calls.jsonl");
    const base = {ts: Date.now()/1000, provider: "codex-direct", arm: "offline",
      slug: "page", model: "gpt-6-astra", prompt_tokens: 1000,
      cached_tokens: 200, completion_tokens: 100, reasoning_tokens: 20, status: "ok"};
    writeFileSync(ledger, [
      {...base, request_id: "direct-ok"},
      {...base, request_id: "direct-empty", status: "error", prompt_tokens: 0,
        cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0}
    ].map(JSON.stringify).join("\n")+"\n");
    const server=join(work,"server.mjs");
    copyFileSync(join(PROJECT,"server.mjs"),server);
    const config=Buffer.from(JSON.stringify({compact:false,
      machine:{id:"fixture",claudeRoots:[],codexRoots:[],ocgoLedgers:[ledger]}})).toString("base64");
    const run=spawnSync(process.execPath,[server,"--agent"],{encoding:"utf8",
      env:{...process.env,HOME:work,CC_AGENT_B64:config}});
    assert.equal(run.status,0,run.stderr);
    const rows=JSON.parse(run.stdout);
    assert.equal(rows.length,2);
    const row=rows.find(r=>r.id==="direct-ok");
    assert.equal(row.source,"codex");
    assert.equal(row.realCwd,"codex-direct/offline");
    assert.deepEqual(row.mainModels,["gpt-6-astra"]);
    assert.equal(row.unpriced,false);
    assert.ok(Math.abs(row.usd-0.0132)<1e-10);
    assert.equal(row.breakdown[0].outR,20);
    assert.equal(rows.find(r=>r.id==="direct-empty").empty,true);
  } finally {rmSync(work,{recursive:true,force:true});}
});
