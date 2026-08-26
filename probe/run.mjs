// CDP harness for running WebMCP probe pages in headless Chrome.
//
// Why not --dump-dom --virtual-time-budget: executeTool() round-trips through
// the browser process, which virtual time does not drive. Virtual time races
// ahead, the budget expires, and Chrome dumps the DOM before tool execution
// resolves. So we drive a real browser and poll for a completion flag instead.
//
// Contract with the page: set window.__probeDone = true when finished, and put
// structured results on window.__probeResults.
//
// Usage:
//   node run.mjs index.html                                  (probe server on :8787)
//   node run.mjs --url http://localhost:5173/tests/x.html    (any URL)

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const PORT = 9333;
const PROBE_ORIGIN = `http://localhost:${process.env.PROBE_PORT ?? 8787}`;

function resolveTargetUrl(args) {
  const i = args.indexOf('--url');
  if (i !== -1) {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error('--url needs a value');
    return value;
  }
  const page = args.find((a) => !a.startsWith('--')) ?? 'index.html';
  return `${PROBE_ORIGIN}/${page}`;
}

const targetUrl = resolveTargetUrl(argv);
const TIMEOUT_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('DevTools endpoint never became ready');
}

let profileDir;
let chrome;

async function main() {
  profileDir = await mkdtemp(join(tmpdir(), 'webmcp-probe-'));

  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // The switch that turns on document.modelContext. Chrome also exposes this
    // as chrome://flags/#enable-webmcp-testing for interactive use.
    '--enable-features=WebMCP',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ];

  chrome = spawn('google-chrome', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  chrome.stderr.on('data', (d) => stderr.push(d.toString()));

  await waitForDevTools();

  // Open the target page in a fresh tab.
  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: 'PUT' },
  )).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  const pageErrors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '?').join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    // Without this, a thrown Error serialises to {} under returnByValue, because
    // Error has no enumerable own properties. Silent empty results follow.
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      const text = details.exception?.description ?? details.text ?? 'evaluation threw';
      throw new Error(text.split('\n')[0]);
    }
    return response.result.value;
  };

  // --eval mode: run one expression against the loaded page and print it.
  // Used to verify a deployed URL, where the origin-isolation requirement can
  // finally be checked. Waits for the expression to stop throwing.
  const evalIndex = argv.indexOf('--eval');
  if (evalIndex !== -1) {
    const expression = argv[evalIndex + 1];
    if (!expression) throw new Error('--eval needs an expression');

    const evalDeadline = Date.now() + 15_000;
    let value;
    let lastError;
    while (Date.now() < evalDeadline) {
      try {
        // CDP already serialises the result with returnByValue, and awaitPromise
        // resolves a promise-returning expression, so no manual encoding.
        value = await evaluate(expression);
        if (value !== undefined && value !== null) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(300);
    }

    ws.close();
    if (pageErrors.length) {
      console.log('PAGE ERRORS');
      for (const e of pageErrors) console.log('  ' + e.split('\n')[0]);
      console.log('');
    }
    if (value === undefined || value === null) {
      console.log(`eval produced nothing${lastError ? `: ${lastError.message}` : ''}`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    return;
  }

  // Poll for the page's completion flag.
  const deadline = Date.now() + TIMEOUT_MS;
  let done = false;
  while (Date.now() < deadline) {
    done = await evaluate('Boolean(window.__probeDone)').catch(() => false);
    if (done) break;
    await sleep(250);
  }

  const results = await evaluate('JSON.stringify(window.__probeResults ?? null)').catch(() => null);
  const env = await evaluate('JSON.stringify(window.__probeEnv ?? null)').catch(() => null);

  ws.close();

  if (pageErrors.length) {
    console.log('PAGE ERRORS');
    for (const e of pageErrors) console.log('  ' + e.split('\n')[0]);
    console.log('');
  }
  if (consoleLines.length) {
    console.log('CONSOLE');
    for (const l of consoleLines) console.log('  ' + l);
    console.log('');
  }
  if (!done) console.log(`WARNING: page never set __probeDone (waited ${TIMEOUT_MS}ms)\n`);

  if (env) {
    console.log('ENVIRONMENT');
    for (const [k, v] of Object.entries(JSON.parse(env))) {
      console.log(`  ${String(k).padEnd(22)}${v}`);
    }
    console.log('');
  }

  const parsed = results ? JSON.parse(results) : null;
  if (!parsed) {
    console.log('No results reported.');
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  console.log(`RESULTS (${parsed.length})`);
  for (const r of parsed) {
    if (r.status === 'fail') failures += 1;
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    console.log(`  [${mark}] ${r.title}${r.detail ? `  ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(failures === 0 ? `All ${parsed.length} passed.` : `${failures} of ${parsed.length} FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('harness error:', error.message);
  process.exitCode = 1;
} finally {
  chrome?.kill('SIGKILL');
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
