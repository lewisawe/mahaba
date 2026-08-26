import { defineConfig } from 'vite';

// WebMCP requires an origin-keyed agent cluster, so the dev server has to send
// Origin-Agent-Cluster: ?1 exactly like production does. Without it,
// registerTool() rejects with SecurityError. See probe/FINDINGS.md.
const webmcpHeaders = {
  'Origin-Agent-Cluster': '?1',
};

export default defineConfig({
  server: {
    port: 5173,
    headers: webmcpHeaders,
  },
  preview: {
    port: 4173,
    headers: webmcpHeaders,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
