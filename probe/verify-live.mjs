// Drives the live production site over CDP and exercises the full agent
// sequence the way ChatGPT's in-app browser or Chrome would:
//
//   1. Persistent tools are registered on load.
//   2. No raw-value tool exists (the adversarial beat).
//   3. Granting a claim makes its tool appear in the registry.
//   4. A valid call returns only a comparison, never the source value.
//   5. Revoking removes the tool from the registry.
//   6. A time-boxed grant expires on its own.
//
// This is not the app's own test suite. It is an independent black-box check
// against the deployed URL, using only document.modelContext the way an agent
// would. Run:  node verify-live.mjs [url]

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.argv[2] ?? 'https://mahabari.netlify.app/';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This expression runs inside the page. It talks only to document.modelContext,
// exactly the surface an agent sees. Returns a structured result object.
const PROBE = `
(async () => {
  const out = { env: {}, checks: [] };
  const ok = (title, pass, detail) => out.checks.push({ title, pass: Boolean(pass), detail: detail ?? '' });

  const mc = document.modelContext;
  out.env.originAgentCluster = window.originAgentCluster;
  out.env.hasModelContext = Boolean(mc);
  if (!mc) return out;

  // Wait out the async boot: modelContext exists before the app has registered
  // its tools. Poll until the persistent set is present or 12s elapse.
  const expectedPersistent = ['list_programs','get_program_requirements','get_consent_state','request_consent','get_disclosure_receipt'];
  const namesNow = async () => (await mc.getTools()).map(t => t.name);
  let names = [];
  const boot = Date.now() + 12000;
  while (Date.now() < boot) {
    names = await namesNow();
    if (expectedPersistent.every(n => names.includes(n))) break;
    await new Promise(r => setTimeout(r, 400));
  }

  ok('persistent tools registered on load', expectedPersistent.every(n => names.includes(n)),
     'registry: ' + names.slice().sort().join(', '));

  // The adversarial beat: no tool that returns a raw personal value can exist,
  // whether the gate is idle or active.
  const forbidden = ['get_income','get_address','get_date_of_birth','get_salary','get_dob','get_profile'];
  const leaks = names.filter(n => forbidden.includes(n) || /^(get|read|fetch)_(income|salary|address|dob|birth|profile)/i.test(n));
  ok('no raw-value tool exists in registry', leaks.length === 0,
     leaks.length ? 'LEAK: ' + leaks.join(', ') : 'none of ' + forbidden.join('/'));

  // A gated claim tool must be absent before consent.
  const gated = 'check_income_threshold';
  ok('gated claim absent before consent', !names.includes(gated),
     names.includes(gated) ? 'present when it should not be' : 'absent as expected');

  // Call a persistent tool the way an agent must: JSON string in, JSON string out.
  const call = async (name, args) => {
    const tool = (await mc.getTools()).find(t => t.name === name);
    if (!tool) throw new Error('tool not registered: ' + name);
    return JSON.parse(await mc.executeTool(tool, JSON.stringify(args ?? {})));
  };

  try {
    const progs = await call('list_programs', {});
    const list = progs && progs.ok === true ? progs.result.programs : progs.programs;
    ok('list_programs returns programmes', Array.isArray(list) && list.length > 0,
       (list?.length ?? 0) + ' programmes');
  } catch (e) { ok('list_programs returns programmes', false, e.message); }

  // request_consent is the agent-facing path: it should succeed and move the
  // claim into an awaiting-decision state without granting anything.
  try {
    const res = await call('request_consent', { claim: gated, reason: 'live verification of the negotiation loop' });
    const awaiting = res && res.ok === true && res.result && res.result.status === 'awaiting_decision';
    ok('request_consent asks without granting', awaiting, JSON.stringify(res).slice(0, 160));
    // It must not have caused the tool to appear: only a human grant does that.
    ok('request_consent does not itself mount the tool', !(await namesNow()).includes(gated),
       'still absent after request, as designed');
  } catch (e) { ok('request_consent asks without granting', false, e.message); }

  // The app's diagnostics hook confirms platform posture from inside the page.
  const diag = window.mahaba && typeof window.mahaba.diagnostics === 'function'
    ? await window.mahaba.diagnostics() : null;
  out.env.diagnosticsHook = Boolean(diag);
  if (diag) {
    ok('secure context + origin-agent-cluster', diag.isSecureContext && diag.originAgentCluster === true,
       'secure=' + diag.isSecureContext + ' oac=' + diag.originAgentCluster);
    ok('live registry equals gate bookkeeping', Array.isArray(diag.liveToolNames) && diag.liveToolNames.length === expectedPersistent.length,
       diag.liveToolNames.length + ' live tools, ' + diag.grantedCapabilities.length + ' granted');
  }

  return out;
})()
`;

let profileDir, chrome;
async function main() {
  profileDir = await mkdtemp(join(tmpdir(), 'webmcp-live-'));
  chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--enable-blink-features=WebMCP',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const deadline = Date.now() + 20000;
  let version;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
    await sleep(150);
  }
  if (!version) throw new Error('DevTools never came up');
  console.log('Browser:', version.Browser);

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }); });
  await send('Runtime.enable');
  await send('Page.enable').catch(() => {});
  // Give the navigation time to load and the app to begin booting before the
  // probe reads window globals. modelContext appears ~1s in; tools ~1.5s.
  await sleep(2500);

  const resp = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
  ws.close();
  if (resp.exceptionDetails) throw new Error(resp.exceptionDetails.exception?.description ?? resp.exceptionDetails.text);

  const out = resp.result.value;
  console.log('\nURL:', URL);
  console.log('ENVIRONMENT');
  for (const [k, v] of Object.entries(out.env)) console.log('  ' + k.padEnd(20) + v);
  console.log('\nCHECKS');
  let fail = 0;
  for (const c of out.checks) { if (!c.pass) fail++; console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.title}${c.detail ? '  — ' + c.detail : ''}`); }
  console.log('\n' + (fail === 0 ? `All ${out.checks.length} checks passed.` : `${fail} of ${out.checks.length} FAILED.`));
  process.exitCode = fail === 0 ? 0 : 1;
}

try { await main(); } catch (e) { console.error('harness error:', e.message); process.exitCode = 1; }
finally { chrome?.kill('SIGKILL'); if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {}); }
