// Minimal static server for the WebMCP capability probe.
//
// WebMCP requires an origin-isolated (origin-keyed agent cluster) document.
// Per spec, registerTool() rejects with SecurityError when the agent cluster is
// not origin-keyed. Origin-keying is opt-in via the Origin-Agent-Cluster header,
// so a plain static file server is not sufficient to test WebMCP locally.
//
// localhost counts as a secure context, so HTTPS is not needed here.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  // Resolve the request path inside ROOT only. normalize() collapses ".."
  // segments so a crafted URL cannot escape the probe directory.
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(requested === '/' ? '/index.html' : requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    const headers = {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    // Set NO_OAC=1 to omit the header and confirm it is genuinely required.
    if (!process.env.NO_OAC) headers['Origin-Agent-Cluster'] = '?1';
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`probe: http://localhost:${PORT}`);
  console.log('Chrome needs chrome://flags/#enable-webmcp-testing set to Enabled.');
});
