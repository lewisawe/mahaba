# WebMCP platform findings

Verified against Google Chrome 152.0.7977.64 on Linux, 2026-08-26, via
`probe/index.html` driven by `probe/run.mjs`. Nine of nine assertions pass.

Reproduce with:

```bash
cd probe
node server.mjs &          # serves on :8787 with Origin-Agent-Cluster: ?1
node run.mjs index.html    # headless Chrome + CDP, prints assertion results
node run.mjs exec-matrix.html
```

## Enabling WebMCP

| Context | How |
|---------|-----|
| Interactive Chrome | `chrome://flags/#enable-webmcp-testing` set to Enabled |
| Command line | `--enable-features=WebMCP` (also works: `--enable-blink-features=WebMCP`) |

`--enable-features=WebMCPTesting` also worked. `EnableWebMCPTesting` and
`WebMachineLearningWebMCP` did not.

## Confirmed behaviour

### Revocation is AbortSignal-based

There is no `unregister()`. A tool is revoked by aborting the signal handed to
`registerTool`:

```js
const controller = new AbortController();
await document.modelContext.registerTool(toolDef, { signal: controller.signal });
controller.abort();   // tool is gone from the registry
```

One `AbortController` per grant is the whole mechanism behind capability-gate.

### A revoked tool cannot be executed, even with a stale handle

Holding a `RegisteredTool` object obtained before revocation confers no access.
`executeTool` rejects after the tool is unregistered. This is the security
property the project depends on, and it holds.

### Time-boxed grants need nothing special

`setTimeout(() => controller.abort(), ttl)` is a complete implementation of an
expiring capability. Verified with a 150ms grant.

### `toolchange` fires on both register and revoke

`document.modelContext.addEventListener('toolchange', ...)`. Confirmed 2 events
across one register/revoke pair, so UI can render from the event.

### Duplicate names are rejected

Registering a name that is already registered rejects with `InvalidStateError`.
capability-gate must therefore guard against double-grant rather than relying on
re-registration to overwrite.

### Names can be reused after revocation

Revoke then re-register the same name works, and the new implementation is the
one that runs. Capabilities can be re-granted.

## Divergences from the specification

These cost time to find. The spec text does not describe the shipped behaviour.

### `executeTool` takes a JSON string, not an object

The spec declares `executeTool(RegisteredTool tool, optional object inputObject = {})`.
Chrome 152 takes a **JSON string** and the argument is **required**.

```js
// Fails: UnknownError "Failed to parse input arguments"
await mc.executeTool(tool, { q: 'x' });

// Fails: TypeError, 2 arguments required
await mc.executeTool(tool);

// Works
await mc.executeTool(tool, JSON.stringify({ q: 'x' }));
```

Passing an object stringifies to `"[object Object]"`, which is not valid JSON,
which is exactly the error text. Every object form failed and every JSON string
form passed across ten combinations in `exec-matrix.html`.

The return value is likewise a JSON string that the caller parses.

### `inputSchema` is not enforced

Chrome does not validate arguments against the declared schema. A tool whose
schema marks a property `required` still executes when that property is absent.

The schema is advisory metadata for the agent, not a validation boundary.
**Every tool must validate its own input.** For this project that matters
directly: a claim-checking tool cannot assume its arguments are well-formed.

### Origin isolation

The spec requires an origin-keyed agent cluster and rejects `registerTool` with
`SecurityError` otherwise. Chrome's docs say WebMCP is unavailable in
non-origin-isolated documents.

localhost reports `window.originAgentCluster === true` with or without the
`Origin-Agent-Cluster: ?1` response header, so the requirement could not be
disproven locally. Agent clusters are site-keyed by default, so a deployed
subdomain is not expected to be origin-keyed without the header.

Decision: send `Origin-Agent-Cluster: ?1` in production. It is free and correct
per spec. Confirm on the first deploy by checking `window.originAgentCluster`.

## Testing notes

`--dump-dom` with `--virtual-time-budget` does not work for WebMCP.
`executeTool` round-trips through the browser process, which virtual time does
not drive, so the budget expires and Chrome dumps the DOM before tool execution
resolves. Symptom: a truncated assertion list and no completion marker.

`probe/run.mjs` drives real Chrome over CDP and polls for `window.__probeDone`
instead. Pages report structured results on `window.__probeResults` and
environment facts on `window.__probeEnv`.

## Relevance to the submission

Specification section 6.3.3, "Privacy Leakage Through Over-Parameterization",
describes sites defining highly parameterized tools that agents helpfully fill
from personalization context, producing silent user profiling.

Section 6.4 lists mitigations: maximum input lengths, shared attack eval
datasets, and an untrusted-content annotation. None of them addresses
over-parameterization; the spec marks it only as "potentially" covered by shared
evals.

This project is a proposed answer to a named and currently unmitigated risk in
the specification: minimally parameterized tools whose registration is gated on
explicit, expiring, revocable user consent.
