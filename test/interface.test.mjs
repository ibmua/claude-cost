import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const chrome = process.env.CHROME_BIN || ['google-chrome', 'chromium', 'chromium-browser'].find(bin => spawnSync(bin, ['--version']).status === 0);

test('fresh install renders only Usage desk at default and historical URLs', { skip: !chrome && 'Install Chrome/Chromium or set CHROME_BIN for browser regression', timeout: 60000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'claude-cost-interface-'));
  let child;
  try {
    for (const path of ['server.mjs', 'public', 'vendor']) cpSync(new URL('../' + path, import.meta.url), join(work, path), { recursive: true });
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [join(work, 'server.mjs')], { env: { ...process.env, HOME: work, PORT: String(port), CLAUDE_COST_CRED_DIRS: work, USAGE_CACHE_DIR: join(work, 'usage-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, errors);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, `HTTP server should start: ${errors}`);
    for (const path of ['/', '/?empty=1', '/?view=classic', '/?view=studio&panel=history']) {
      const run = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, 'browser')}`, '--virtual-time-budget=1500', '--dump-dom', url + path], { encoding: 'utf8', timeout: 12000, maxBuffer: 5 * 1024 * 1024 });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /<body[^>]*class="[^"]*usage-desk/, `${path}: desk styles must initialize`);
      assert.match(run.stdout, /<nav aria-label="Dashboard views">/, `${path}: new navigation must render`);
      assert.match(run.stdout, /<strong>Usage desk<\/strong>/, `${path}: Usage desk must mount`);
      assert.doesNotMatch(run.stdout, /Classic interface/, `${path}: no route back to retired interface`);
      assert.match(run.stdout, path.includes('panel=history') ? /<h1>History<\/h1>/ : /<h1>Sessions<\/h1>/, `${path}: expected panel must render`);
    }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(work, { recursive: true, force: true });
  }
});
