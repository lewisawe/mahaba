/**
 * Day 2 stub.
 *
 * Purpose is to prove the deployment pipeline: that WebMCP is available on the
 * deployed origin, that capability-gate registers and revokes real tools there,
 * and that the console can render from browser ground truth.
 *
 * The real program set, negotiation loop and signed receipts come later. What is
 * here is the load-bearing part.
 */

import { createCapabilityGate, type AuditEntry, type GateSnapshot } from './lib/capability-gate';
import './styles.css';

/* ------------------------------------------------------------------ *
 * Synthetic demo profile. Stays in this browser. Never returned by a tool.
 * ------------------------------------------------------------------ */

const PROFILE = {
  annualIncome: 24_000,
  age: 34,
  householdSize: 4,
  district: 'north',
} as const;

/* ------------------------------------------------------------------ *
 * Environment panel
 * ------------------------------------------------------------------ */

function renderEnvironment(): void {
  const host = document.getElementById('env');
  if (!host) return;

  const mc = document.modelContext;
  const rows: Array<[string, string, 'good' | 'bad' | 'plain']> = [
    ['isSecureContext', String(window.isSecureContext), window.isSecureContext ? 'good' : 'bad'],
    [
      'originAgentCluster',
      String(window.originAgentCluster ?? '(unsupported)'),
      window.originAgentCluster === true ? 'good' : 'bad',
    ],
    ['document.modelContext', mc ? 'present' : 'missing', mc ? 'good' : 'bad'],
    ['origin', window.location.origin, 'plain'],
  ];

  for (const [label, value, state] of rows) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    if (state !== 'plain') dd.dataset.state = state;
    wrap.append(dt, dd);
    host.append(wrap);
  }

  if (!mc) {
    const wrap = document.createElement('div');
    const dd = document.createElement('dd');
    dd.dataset.state = 'bad';
    dd.textContent = 'WebMCP unavailable. In Chrome, enable chrome://flags/#enable-webmcp-testing.';
    wrap.append(document.createElement('dt'), dd);
    host.append(wrap);
  }
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

const gate = createCapabilityGate();

/** Reject anything that is not a plain object, before touching its fields. */
function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object of arguments');
  }
  return raw as Record<string, unknown>;
}

function requireFiniteNumber(raw: unknown, field: string): number {
  const value = asRecord(raw)[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${field}" must be a finite number`);
  }
  return value;
}

function defineCapabilities(): void {
  // Persistent: discloses nothing about the person on its own.
  gate.define<Record<string, never>, { capabilities: unknown }>('get_consent_state', {
    description:
      'Report which eligibility claims this person has currently permitted, and which are unavailable. Call this before attempting any check.',
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}) as Record<string, never>,
    execute: () => {
      const { capabilities } = gate.snapshot();
      return {
        capabilities: capabilities.map((capability) => ({
          name: capability.name,
          available: capability.granted,
          description: capability.description,
        })),
      };
    },
  });

  // Consent-gated. Answers a comparison. The income itself is never in scope of
  // any return value, which is what makes the adversarial demo beat work.
  gate.define<{ threshold: number }, { belowThreshold: boolean; claim: string }>(
    'check_income_threshold',
    {
      description:
        'Answer whether this household\'s annual income is below a given threshold. Returns only true or false, never the income itself.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Annual income threshold in whole currency units.' },
        },
        required: ['threshold'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      validate: (raw) => ({ threshold: requireFiniteNumber(raw, 'threshold') }),
      execute: ({ threshold }) => ({
        belowThreshold: PROFILE.annualIncome < threshold,
        claim: `income below ${threshold}`,
      }),
      summarize: ({ threshold }) => `compared income against ${threshold}`,
    },
  );

  gate.define<{ minimumAge: number }, { meetsMinimum: boolean; claim: string }>(
    'check_age_requirement',
    {
      description:
        'Answer whether this person meets a minimum age requirement. Returns only true or false, never a date of birth or exact age.',
      inputSchema: {
        type: 'object',
        properties: { minimumAge: { type: 'number', description: 'Minimum age in years.' } },
        required: ['minimumAge'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      validate: (raw) => ({ minimumAge: requireFiniteNumber(raw, 'minimumAge') }),
      execute: ({ minimumAge }) => ({
        meetsMinimum: PROFILE.age >= minimumAge,
        claim: `at least ${minimumAge} years old`,
      }),
      summarize: ({ minimumAge }) => `confirmed age against minimum ${minimumAge}`,
    },
  );
}

/* ------------------------------------------------------------------ *
 * Console rendering
 * ------------------------------------------------------------------ */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function renderConsole(snapshot: GateSnapshot): void {
  const host = document.getElementById('console');
  if (!host) return;
  host.textContent = '';

  for (const capability of snapshot.capabilities) {
    if (!capability.granted) continue;

    const el = document.createElement('div');
    el.className = 'capability';
    el.dataset.persistent = String(capability.persistent);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = capability.name;

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = capability.persistent
      ? 'always on'
      : capability.readOnly
        ? 'read'
        : 'write';

    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = capability.description;

    el.append(name, kind, desc);

    if (capability.expiresAt !== null) {
      const expiry = document.createElement('span');
      expiry.className = 'expiry';
      const seconds = Math.max(0, Math.round((capability.expiresAt - Date.now()) / 1000));
      expiry.textContent = `expires ${RELATIVE.format(seconds, 'second')}`;
      el.append(expiry);
    }

    host.append(el);
  }
}

function renderAudit(entries: readonly AuditEntry[]): void {
  const host = document.getElementById('audit');
  if (!host) return;
  host.textContent = '';

  for (const entry of entries.slice(-40).reverse()) {
    const li = document.createElement('li');
    li.dataset.type = entry.type;

    const time = document.createElement('time');
    const at = new Date(entry.at);
    time.dateTime = at.toISOString();
    time.textContent = at.toLocaleTimeString([], { hour12: false });

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = entry.type;

    const detail = document.createElement('span');
    detail.textContent = describe(entry);

    li.append(time, tag, detail);
    host.append(li);
  }
}

function describe(entry: AuditEntry): string {
  switch (entry.type) {
    case 'granted':
      return `${entry.name}${entry.ttlMs === null ? '' : ` for ${Math.round(entry.ttlMs / 1000)}s`}${entry.reason ? ` (${entry.reason})` : ''}`;
    case 'revoked':
      return `${entry.name} (${entry.cause})`;
    case 'called':
      return entry.summary;
    case 'denied':
      return `${entry.name}: ${entry.code} — ${entry.message}`;
    case 'requested':
      return `${entry.name} (${entry.reason})`;
  }
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

const GRANT_TTL_MS = 60_000;

function renderControls(): void {
  const host = document.getElementById('controls');
  if (!host) return;
  host.textContent = '';

  const revocable = gate.snapshot().capabilities.filter((capability) => !capability.persistent);

  for (const capability of revocable) {
    const button = document.createElement('button');
    button.type = 'button';
    const label = capability.name.replace(/^check_/, '').replace(/_/g, ' ');
    button.textContent = capability.granted ? `Revoke ${label}` : `Grant ${label}`;
    button.dataset.variant = capability.granted ? 'revoke' : 'grant';
    button.disabled = !gate.available;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (gate.isGranted(capability.name)) {
          gate.revoke(capability.name);
        } else {
          await gate.grant(capability.name, {
            ttlMs: GRANT_TTL_MS,
            reason: 'granted from the console',
          });
        }
      } catch (error) {
        console.error('capability toggle failed', error);
      } finally {
        renderControls();
      }
    });
    host.append(button);
  }
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 *
 * A deliberate debug affordance. The origin-isolation requirement cannot be
 * verified on localhost, so there has to be a way to confirm on the deployed
 * URL that WebMCP is genuinely available and that tools really registered.
 * Reports state only, and exposes no profile data.
 * ------------------------------------------------------------------ */

export interface Diagnostics {
  isSecureContext: boolean;
  originAgentCluster: boolean | null;
  webmcpAvailable: boolean;
  origin: string;
  definedCapabilities: number;
  liveToolNames: string[];
}

async function diagnostics(): Promise<Diagnostics> {
  return {
    isSecureContext: window.isSecureContext,
    originAgentCluster: window.originAgentCluster ?? null,
    webmcpAvailable: gate.available,
    origin: window.location.origin,
    definedCapabilities: gate.snapshot().capabilities.length,
    liveToolNames: await gate.liveToolNames(),
  };
}

declare global {
  interface Window {
    proofNotProfile?: { diagnostics: () => Promise<Diagnostics> };
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  window.proofNotProfile = { diagnostics };

  renderEnvironment();
  defineCapabilities();

  gate.subscribe((snapshot) => {
    renderConsole(snapshot);
    renderAudit(gate.audit());
  });

  if (gate.available) {
    await gate.start();
  }

  renderControls();

  // Keep expiry countdowns honest without re-rendering the whole page.
  setInterval(() => renderConsole(gate.snapshot()), 1000);
}

void boot();
