// One-shot test runner: boots the Vite dev server via its JS API (so the
// Origin-Agent-Cluster header from vite.config.ts is sent, which WebMCP
// requires), runs each CDP suite against it with probe/run.mjs, then shuts the
// server down and exits non-zero if any suite failed.
//
// This exists so the browser suites can run in one command that terminates,
// rather than needing a dev server left running in a separate terminal.
//
//   node probe/ci-tests.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SUITES = [
  'tests/capability-gate.html',
  'tests/agent-workflow.html',
];

function runSuite(url) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(here, 'run.mjs'), '--url', url], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const server = await createServer({ root, configFile: join(root, 'vite.config.ts') });
await server.listen();
const info = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
const base = info.endsWith('/') ? info.slice(0, -1) : info;
console.log(`dev server on ${base}\n`);

let failed = 0;
try {
  for (const suite of SUITES) {
    console.log(`\n=== ${suite} ===`);
    const code = await runSuite(`${base}/${suite}`);
    if (code !== 0) failed += 1;
  }
} finally {
  await server.close();
}

if (failed > 0) {
  console.log(`\n${failed} suite(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log('\nAll suites passed.');
}
