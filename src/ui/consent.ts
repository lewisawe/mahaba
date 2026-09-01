/**
 * The capability console and the consent surface.
 *
 * The console is the hero of the interface: it shows exactly what the agent can
 * do right now, and it is rendered from the gate's snapshot so it cannot claim a
 * capability the browser has not registered.
 */

import type { CapabilityState, GateSnapshot } from '../lib/capability-gate';
import { CLAIMS, CLAIM_IDS, toolNameFor, type ClaimId } from '../domain/claims';
import { DRAFT_TOOL } from '../capabilities';
import { button, el, replaceChildren, secondsUntil } from './dom';

export interface ConsentActions {
  grant: (tool: string, reason: string) => Promise<void>;
  revoke: (tool: string) => void;
  deny: (tool: string) => void;
}

/** Default window for a grant made from the UI. */
export const GRANT_TTL_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Capability console
 * ------------------------------------------------------------------ */

function capabilityRow(capability: CapabilityState): HTMLElement {
  const kind = capability.persistent
    ? 'always on'
    : capability.readOnly
      ? 'read'
      : 'write';

  const children = [
    el('span', { class: 'name', text: capability.name }),
    el('span', { class: 'kind', text: kind }),
    el('span', { class: 'desc', text: capability.description }),
  ];

  // Urgency ramps in the final stretch so expiry reads on screen without
  // anyone touching the page. The gate re-renders once a second while anything
  // is expiring, so this stays live.
  let urgency: 'calm' | 'soon' | 'imminent' = 'calm';
  if (capability.expiresAt !== null) {
    const seconds = secondsUntil(capability.expiresAt);
    urgency = seconds <= 5 ? 'imminent' : seconds <= 15 ? 'soon' : 'calm';
    children.push(
      el('span', {
        class: 'expiry',
        text: seconds > 0 ? `expires in ${seconds}s` : 'expiring',
      }),
    );
  }

  if (capability.callCount > 0) {
    children.push(
      el('span', {
        class: 'calls',
        text: capability.callCount === 1 ? 'called once' : `called ${capability.callCount} times`,
      }),
    );
  }

  return el(
    'div',
    {
      class: 'capability',
      data: {
        persistent: String(capability.persistent),
        expiring: String(capability.expiresAt !== null),
        urgency,
      },
    },
    children,
  );
}

export function renderConsole(host: HTMLElement | null, snapshot: GateSnapshot): void {
  if (!host) return;
  const granted = snapshot.capabilities.filter((capability) => capability.granted);
  // Consented capabilities first: they are the interesting ones.
  granted.sort((a, b) => Number(a.persistent) - Number(b.persistent) || a.name.localeCompare(b.name));
  replaceChildren(host, ...granted.map(capabilityRow));
}

/**
 * Live count of tools the agent can currently call. Rendered from the gate
 * snapshot so it moves the instant a grant or revocation changes the registry.
 * This is the number that dramatizes the whole thesis: the registry is state.
 */
export function renderConsoleCount(host: HTMLElement | null, snapshot: GateSnapshot): void {
  if (!host) return;
  const granted = snapshot.capabilities.filter((c) => c.granted).length;
  const consented = snapshot.capabilities.filter((c) => c.granted && !c.persistent).length;
  replaceChildren(
    host,
    el('span', { class: 'tool-count-n', text: String(granted) }),
    el('span', {
      text:
        granted === 1
          ? ' tool callable'
          : ` tools callable${consented > 0 ? `, ${consented} by your consent` : ''}`,
    }),
  );
}

/**
 * The inspectable proof of the adversarial beat. Rather than assert "the agent
 * can't get your income", check a set of raw-value tool names against the
 * browser's own live registry and show that none of them exist. The absence is
 * demonstrated from ground truth, not claimed.
 */
const FORBIDDEN_RAW_TOOLS = [
  'get_income',
  'get_salary',
  'get_address',
  'get_date_of_birth',
] as const;

export function renderCannot(host: HTMLElement | null, liveToolNames: string[]): void {
  if (!host) return;
  const present = FORBIDDEN_RAW_TOOLS.filter((name) => liveToolNames.includes(name));

  replaceChildren(
    host,
    el('p', { class: 'cannot-head', text: 'What the agent cannot ask for' }),
    el(
      'ul',
      { class: 'cannot-list' },
      FORBIDDEN_RAW_TOOLS.map((name) =>
        el('li', { data: { present: String(present.includes(name)) } }, [
          el('span', { class: 'cannot-mark', attrs: { 'aria-hidden': 'true' }, text: '\u2717' }),
          el('code', { text: name }),
          el('span', { class: 'sr-only', text: ' is not registered' }),
        ]),
      ),
    ),
    el('p', {
      class: 'cannot-note',
      text:
        present.length === 0
          ? 'None of these tools exist in the registry, so there is nothing for the agent to call. The absence is the mechanism.'
          : 'A raw-value tool is present. This should never happen.',
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Pending consent requests, raised by the agent
 * ------------------------------------------------------------------ */

export function renderPending(
  host: HTMLElement | null,
  snapshot: GateSnapshot,
  actions: ConsentActions,
): void {
  if (!host) return;

  if (snapshot.pending.length === 0) {
    replaceChildren(host);
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const rows = snapshot.pending.map((request) => {
    const claimId = CLAIM_IDS.find((id) => toolNameFor(id) === request.name);
    const spec = claimId ? CLAIMS[claimId] : undefined;

    return el('div', { class: 'request' }, [
      el('p', { class: 'request-title', text: spec ? spec.label : request.name }),
      el('p', { class: 'request-reason' }, [
        el('span', { class: 'quiet', text: 'The agent says: ' }),
        // Agent-authored text. Set as a text node, never parsed as markup.
        el('q', { text: request.reason }),
      ]),
      // Flag the provenance: this line is untrusted content authored by the
      // agent (untrustedContentHint), not a claim the site is making.
      el('p', { class: 'request-untrusted', attrs: { role: 'note' } }, [
        el('span', { class: 'untrusted-badge', text: 'agent-authored' }),
        el('span', { class: 'quiet', text: ' — treat this wording as untrusted; grant on the claim, not the phrasing.' }),
      ]),
      spec ? el('p', { class: 'request-discloses', text: spec.discloses }) : null,
      el('div', { class: 'request-actions' }, [
        button(
          `Permit for ${GRANT_TTL_MS / 1000}s`,
          () => actions.grant(request.name, request.reason),
          { variant: 'grant' },
        ),
        button('Decline', () => actions.deny(request.name), { variant: 'revoke' }),
      ]),
    ]);
  });

  replaceChildren(host, ...rows);
}

/* ------------------------------------------------------------------ *
 * Claim-by-claim consent controls
 * ------------------------------------------------------------------ */

function claimControl(
  claimId: ClaimId,
  snapshot: GateSnapshot,
  actions: ConsentActions,
): HTMLElement {
  const spec = CLAIMS[claimId];
  const tool = toolNameFor(claimId);
  const state = snapshot.capabilities.find((capability) => capability.name === tool);
  const granted = state?.granted === true;

  const meta: HTMLElement[] = [
    el('p', { class: 'claim-label', text: spec.label }),
    el('p', { class: 'claim-discloses', text: spec.discloses }),
  ];

  if (granted && state?.expiresAt != null) {
    const seconds = secondsUntil(state.expiresAt);
    meta.push(el('p', { class: 'claim-expiry', text: `permitted, ${seconds}s remaining` }));
  }

  return el('div', { class: 'claim', data: { granted: String(granted) } }, [
    el('div', { class: 'claim-meta' }, meta),
    granted
      ? button('Withdraw', () => actions.revoke(tool), { variant: 'revoke' })
      : button('Permit', () => actions.grant(tool, 'permitted directly from the console'), {
          variant: 'grant',
        }),
  ]);
}

export function renderClaimControls(
  host: HTMLElement | null,
  snapshot: GateSnapshot,
  actions: ConsentActions,
): void {
  if (!host) return;

  const claims = CLAIM_IDS.map((claimId) => claimControl(claimId, snapshot, actions));

  const draftState = snapshot.capabilities.find((capability) => capability.name === DRAFT_TOOL);
  const draftGranted = draftState?.granted === true;

  const draft = el('div', { class: 'claim claim-write', data: { granted: String(draftGranted) } }, [
    el('div', { class: 'claim-meta' }, [
      el('p', { class: 'claim-label', text: 'Draft an application' }),
      el('p', {
        class: 'claim-discloses',
        text: 'Lets the agent assemble an application citing verified claims. Writes, so it is permitted separately.',
      }),
    ]),
    draftGranted
      ? button('Withdraw', () => actions.revoke(DRAFT_TOOL), { variant: 'revoke' })
      : button('Permit', () => actions.grant(DRAFT_TOOL, 'application drafting approved'), {
          variant: 'grant',
        }),
  ]);

  replaceChildren(host, ...claims, draft);
}
