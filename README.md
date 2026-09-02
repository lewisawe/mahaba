# Proof, Not Profile

**A WebMCP wallet where the agent's tool registry is gated on revocable user consent.**

Eligibility forms ask for an exact salary when the decision only needs to know
whether income falls below a threshold. This app answers the question without
exposing the number, and the tools an agent can call exist only while the person
permits them.

Built for [The WebMCP Challenge](https://webmcp.devpost.com/).

**Live: [mahabari.netlify.app](https://mahabari.netlify.app/)**

Open it in the ChatGPT desktop app's built-in browser (site tools), or in
Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.

> Synthetic demo data only, held in the browser. Not affiliated with any
> benefits authority and not a source of advice.

---

## The idea

Every WebMCP reference implementation registers a fixed list of tools once at page
load. The tool set is a constant.

Here it is state. Tools mount when a person grants consent, unmount when consent
is withdrawn or expires, and **no tool exists at any point that returns a raw
personal value**. There is no `get_income`, no `get_address`, no
`get_date_of_birth`. An agent can learn that income is below £30,000. It has no
way to learn what the income is, because the capability to ask does not exist.
The interface makes that absence inspectable: for every raw field the wallet
holds, it checks the getter tool that would read it against the browser's own
`getTools()` and shows it is not there, so the guarantee is demonstrated from
ground truth rather than asserted.

This addresses a named risk in the WebMCP specification. Section 6.3.3,
["Privacy Leakage Through Over-Parameterization"](https://webmachinelearning.github.io/webmcp/#privacy-leakage-over-parameterization),
describes sites defining highly parameterized tools that agents helpfully fill
from personalization context, producing silent profiling and discrimination risk.
Section 6.4 lists three mitigations and none of them addresses it.

Two things ship here: a reusable primitive, and an app that uses it.

## `capability-gate`

[`src/lib/capability-gate.ts`](src/lib/capability-gate.ts) makes a WebMCP tool's
existence a function of consent. It is dependency-free and drop-in for any
WebMCP site.

```ts
const gate = createCapabilityGate();

gate.define('check_income_threshold', {
  description: "Answer whether this household's annual income is below a given threshold.",
  inputSchema: { /* ... */ },
  annotations: { readOnlyHint: true },
  validate: (raw) => ({ threshold: requireFiniteNumber(raw, 'threshold') }),
  execute: ({ threshold }) => ({ belowThreshold: income < threshold }),
  summarize: ({ threshold }) => `compared income against ${threshold}`,
});

await gate.start();                                    // registers persistent tools only

// The tool does not exist yet. Granting brings it into being.
await gate.grant('check_income_threshold', { ttlMs: 60_000, reason: 'Housing Support' });

gate.revoke('check_income_threshold');                 // gone from the registry
```

| Feature | Notes |
|---------|-------|
| Grant and revoke | One `AbortController` per grant. WebMCP has no `unregisterTool`; aborting the registration signal is the only mechanism. |
| Expiring grants | `ttlMs` sets a timer that aborts the signal. The tool removes itself. |
| Persistent capabilities | Registered at `start()`, refuse `grant()`, for tools that disclose nothing alone. |
| Mandatory validation | `validate` is a required field, because Chrome does not enforce `inputSchema`. |
| Structured errors | Tools return `{ ok, result }` or `{ ok, error }` rather than throwing. |
| Trust annotations | Every claim is `readOnlyHint: true`; the write is not; `request_consent` is `untrustedContentHint: true` because the reason it surfaces is agent-authored. |
| Disclosure log | Append-only record of grants, calls, revocations, denials, consent requests and declines. |
| Live subscription | `subscribe()` for UI, `liveToolNames()` for browser ground truth. |

### Errors are returned, not thrown

A thrown error reaches the agent as an opaque `UnknownError` with no message, so
it cannot distinguish a malformed call from a genuine failure. Every gated tool
resolves an envelope instead:

```ts
{ ok: true, result: { belowThreshold: true, claim: 'income below 30000' } }
{ ok: false, error: { code: 'invalid_input', message: '"threshold" must be a finite number' } }
```

### The capability decides what gets logged

`summarize` returns the disclosure-safe description of a call. The income
comparison logs `compared income against 30000` and never the income. A test
asserts the source value appears nowhere in the log, so the record stays safe to
display and export.

## Running it

Requires Node 22+ and Chrome 149+.

```bash
npm install
npm run dev
```

Then enable WebMCP in Chrome at `chrome://flags/#enable-webmcp-testing` and open
the dev server. WebMCP is also available in the ChatGPT desktop app's built-in
browser without a
flag.

```bash
npm run build       # typecheck then production build
npm run typecheck
```

## Tests

Tests run in real Chrome over the DevTools Protocol, because WebMCP tool
execution round-trips through the browser process and cannot be verified in a
DOM-only test environment.

```bash
npm test            # boots the dev server, runs both suites in Chrome, exits
```

`npm test` runs [`probe/ci-tests.mjs`](probe/ci-tests.mjs), which starts the
Vite dev server (so the `Origin-Agent-Cluster: ?1` header WebMCP requires is
sent), drives both suites through `probe/run.mjs`, and shuts the server down. To
run one suite by hand against an already-running server:

```bash
npm run dev                                    # in one terminal
node probe/run.mjs --url http://localhost:5173/tests/capability-gate.html
node probe/run.mjs --url http://localhost:5173/tests/agent-workflow.html
```

The `capability-gate` suite has 19 assertions covering grant, revoke, expiry,
validation, double-grant, consent request and decline, the audit log, and the
property everything depends on: that a revoked tool cannot be executed even by a
caller holding a `RegisteredTool` handle obtained while the grant was live. The
`agent-workflow` suite has 19 more against the real registered tools, including a
sentinel-profile leak test that grants every claim and asserts no raw profile
value appears in any tool result or in the disclosure receipt.

### Official WebMCP evals

The app also passes Google Chrome Labs' own
[`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals)
harness, the first-party tooling the WebMCP team ships. Its `smoke` mode runs
concrete tool calls against the live page over Puppeteer, no LLM, deterministic.
All 5 persistent tools pass end to end (`list_programs`,
`get_program_requirements`, `get_consent_state`, `request_consent`,
`get_disclosure_receipt`). See [`probe/webmcp-evals/`](probe/webmcp-evals/) for
the suite and how to reproduce.

## A second instance, same primitive

`capability-gate` is not specific to benefits. The
[pharmacy checkout](pharmacy.html) is a second app on the exact same gate,
console, and consent loop, with a different claim set: it verifies a buyer clears
an age limit and has no conflicting condition before selling a restricted
medicine, without reading the date of birth or the medical history. Only the
domain changes; the primitive does not.

## Try it fast

Query-param fast-paths preload real state (through the real gate, nothing faked)
so you can land mid-flow:

- [`/?demo=granted`](https://mahabari.netlify.app/?demo=granted) — income claim granted, counting down
- [`/?demo=pending`](https://mahabari.netlify.app/?demo=pending) — the agent has asked for a claim
- [`/?demo=expired`](https://mahabari.netlify.app/?demo=expired) — a grant that has just lapsed

## Platform research

[`probe/FINDINGS.md`](probe/FINDINGS.md) documents WebMCP behaviour verified
against Chrome 152, including two divergences from the specification that cost
real debugging time:

- **`executeTool` takes a JSON string, not an object,** and the argument is
  required. The spec declares `optional object inputObject = {}`. Passing an
  object stringifies to `"[object Object]"` and rejects with
  `Failed to parse input arguments`.
- **`inputSchema` is not enforced.** A tool declaring a property `required` still
  executes when that property is absent. The schema is advisory metadata, not a
  validation boundary, so every tool must validate its own input.

Also documented: WebMCP requires an origin-keyed agent cluster, so deployments
must send `Origin-Agent-Cluster: ?1` or `registerTool` rejects with
`SecurityError`. See [`netlify.toml`](netlify.toml).

`probe/` contains a standalone diagnostic page and the CDP harness:

```bash
cd probe && node server.mjs
node run.mjs index.html                        # 9 platform assertions
node run.mjs exec-matrix.html                  # schema and argument matrix
```

## Layout

```
src/lib/capability-gate.ts   the primitive
src/lib/webmcp.d.ts          spec IDL types, with the Chrome divergence encoded
src/main.ts                  app wiring
src/styles.css               design tokens
tests/                       capability-gate suite
probe/                       platform research and the CDP test harness
netlify.toml                 production headers, including origin isolation
```

## License

[MIT](LICENSE)
