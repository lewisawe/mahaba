# Official WebMCP evals

This runs Google Chrome Labs' own evaluation harness,
[`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals),
against this app's registered tools. It is the first-party tooling the WebMCP
team ships for validating tool-calling, so a passing run is an independent check
rather than one of our own.

`smoke` mode executes concrete expected tool calls against the live page over
Puppeteer, with no LLM and no API key, so it is deterministic and reproducible.

## Result

All 5 persistent tools pass, exercised end to end against the built app:

```
Case                                    Status  Tool
List programmes                         PASS    list_programs
Read a programme's requirements         PASS    get_program_requirements
Report current consent state            PASS    get_consent_state
Negotiate: ask the person for a claim   PASS    request_consent
Return the disclosure receipt           PASS    get_disclosure_receipt

Passed steps: 5/5 across 5 case(s).
```

The consent-gated claim tools (`check_*`) are intentionally not covered here:
they do not exist in the registry until a person grants them, which is the whole
point of the project, so a fresh-page smoke run correctly cannot call them.

## Reproduce

Serve the built app with the `Origin-Agent-Cluster: ?1` header on some port,
then:

```bash
npx --yes webmcp-evals@latest smoke \
  -u http://localhost:8123/ \
  -e probe/webmcp-evals/persistent-tools.evals.json \
  --chrome-channel chrome -v
```

`--chrome-channel chrome` targets stable Chrome; the harness defaults to Chrome
Canary. The eval suite is `persistent-tools.evals.json` in this directory.
