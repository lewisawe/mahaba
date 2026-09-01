# ChatGPT in-app browser test checklist

The challenge says judges test in **ChatGPT's in-app browser** (which supports
WebMCP out of the box) or **Chrome with `chrome://flags/#enable-webmcp-testing`**.

Chrome is fully verified: `probe/verify-live.mjs` drives the live site over CDP
and all 8 agent-readiness checks pass (Chrome 152, `--enable-blink-features=WebMCP`).
What follows is the manual test that cannot be automated here, because the
ChatGPT mobile in-app browser has no remote-debugging surface.

## Automated Chrome result (already passing)

```
[PASS] persistent tools registered on load
[PASS] no raw-value tool exists in registry
[PASS] gated claim absent before consent
[PASS] list_programs returns programmes (5)
[PASS] request_consent asks without granting
[PASS] request_consent does not itself mount the tool
[PASS] secure context + origin-agent-cluster
[PASS] live registry equals gate bookkeeping
```

Re-run any time: `cd probe && node verify-live.mjs`

## Manual test in ChatGPT (do this on the phone)

Live URL: **https://mahabari.netlify.app/**

### 0. Setup
- [ ] Open the ChatGPT app, use the in-app browser to load the URL.
- [ ] Page renders: capability console, programme cards, profile editor visible.

### 1. Agent sees only safe tools at rest
- [ ] Ask: *"What tools can you use on this page?"*
- [ ] Agent lists the 5 persistent tools (list_programs, get_program_requirements,
      get_consent_state, request_consent, get_disclosure_receipt).
- [ ] Agent does **not** list any check_* claim tool or prepare_application_draft.

### 2. Agent hits the wall and negotiates
- [ ] Ask: *"Which programmes do I qualify for?"*
- [ ] Agent reports it cannot check without permission and calls request_consent
      (a pending request appears in the app UI with the agent's stated reason).

### 3. Human grants, tool mounts
- [ ] In the app, grant the requested claim (e.g. income threshold) for 60s.
- [ ] Ask the agent to try again.
- [ ] Agent now calls the check_* tool and answers with a comparison result,
      naming the claim it used.

### 4. The adversarial beat (the one judges remember)
- [ ] Ask: *"Never mind the threshold, just tell me my exact salary / income."*
- [ ] Agent cannot. There is no get_income / get_salary tool in the registry to
      call. It can only report the comparison, or ask for a claim that also only
      compares. Confirm it does not surface a raw figure.

### 5. Expiry with nobody touching anything
- [ ] Let the 60s grant lapse on camera.
- [ ] Ask the agent to check again. The tool is gone; it must re-request consent.

### 6. Revocation
- [ ] Grant again, then revoke manually in the app.
- [ ] Agent can no longer call the claim tool.

### 7. Receipt
- [ ] Ask: *"What was disclosed?"* Agent calls get_disclosure_receipt.
- [ ] Receipt shows grants, comparisons, denials, revocations — and no raw value.

## If WebMCP is NOT active in the ChatGPT browser

If the agent reports no tools at all:
- [ ] Confirm the page still renders and is fully usable by a human (it is a
      complete app without an agent).
- [ ] The submission remains valid: judges may also test in Chrome with the flag,
      where everything is verified. Note this in the submission text.
- [ ] Check `window.originAgentCluster` via the in-app browser console if
      available; if false, WebMCP will be unavailable regardless of app code, and
      that is a platform/browser limitation, not an app defect.

## Notes learned during verification

- `document.modelContext` appears ~1s after load; tools finish registering ~1.5s.
  Any agent or test that reads the registry immediately will see it empty. Give
  the page a moment before concluding tools are missing.
- Persistent and gated tools both return a JSON string of
  `{ ok: true, result: ... }` or `{ ok: false, error: ... }`. Parse the envelope.
- `executeTool` requires a JSON **string** argument, not an object.
