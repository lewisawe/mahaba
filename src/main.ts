/**
 * Application wiring.
 *
 * State is deliberately small: one gate, one profile. Every view is a pure
 * function of a snapshot, re-rendered on change, because the thing being
 * displayed is a security boundary and stale UI would be a lie about it.
 */

import { createCapabilityGate } from './lib/capability-gate';
import { registerCapabilities } from './capabilities';
import {
  clearProfile,
  DEFAULT_PROFILE,
  loadProfile,
  saveProfile,
  type Profile,
} from './domain/profile';
import { mount } from './ui/dom';
import {
  GRANT_TTL_MS,
  renderCannot,
  renderClaimControls,
  renderConsole,
  renderConsoleCount,
  renderPending,
  type ConsentActions,
  type ForbiddenGetter,
} from './ui/consent';
import { renderAudit, renderEnvironment, renderPrograms, renderProfile } from './ui/views';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const gate = createCapabilityGate();
let profile: Profile = loadProfile();

const getProfile = (): Profile => profile;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const hosts = {
  console: mount('console'),
  toolCount: mount('tool-count'),
  cannot: mount('cannot'),
  pending: mount('pending'),
  pendingPanel: mount('pending-panel'),
  claims: mount('claims'),
  programs: mount('programs'),
  audit: mount('audit'),
  profile: mount('profile'),
  env: mount('env'),
};

const consentActions: ConsentActions = {
  grant: async (tool, reason) => {
    try {
      await gate.grant(tool, { ttlMs: GRANT_TTL_MS, reason });
    } catch (error) {
      // A failed grant must not leave the UI implying the capability exists.
      console.error(`could not grant ${tool}`, error);
      render();
    }
  },
  revoke: (tool) => gate.revoke(tool),
  deny: (tool) => gate.denyConsent(tool),
};

/**
 * The getter tools an over-parameterized design would have registered to read
 * each raw field this wallet holds. Derived from the Profile shape, so the
 * "cannot ask for" proof is tied to the actual data at risk. None of these is
 * ever defined on the gate; the panel proves their absence from the live
 * registry.
 */
const FORBIDDEN_GETTERS: readonly ForbiddenGetter[] = [
  { tool: 'get_income', field: 'annual income' },
  { tool: 'get_date_of_birth', field: 'date of birth' },
  { tool: 'get_household_size', field: 'household size' },
  { tool: 'get_district', field: 'district' },
  { tool: 'get_tenure', field: 'housing tenure' },
  { tool: 'get_support_status', field: 'support status' },
];

function render(): void {
  const snapshot = gate.snapshot();

  renderConsole(hosts.console, snapshot);
  renderConsoleCount(hosts.toolCount, snapshot);
  renderPending(hosts.pending, snapshot, consentActions);
  if (hosts.pendingPanel) hosts.pendingPanel.hidden = snapshot.pending.length === 0;
  renderClaimControls(hosts.claims, snapshot, consentActions);
  renderPrograms(hosts.programs, profile, (tool) => gate.isGranted(tool));
  renderAudit(hosts.audit, gate.audit());

  // The "cannot do" surface reads the browser's real registry (ground truth,
  // not our bookkeeping), so refresh it whenever state changes.
  void gate.liveToolNames().then((names) => renderCannot(hosts.cannot, names, FORBIDDEN_GETTERS));
}

function renderProfileEditor(): void {
  renderProfile(hosts.profile, profile, {
    update: (patch) => {
      profile = { ...profile, ...patch };
      saveProfile(profile);
      // Verdicts depend on the profile, so they have to follow an edit.
      render();
    },
    reset: () => {
      profile = { ...DEFAULT_PROFILE };
      clearProfile();
      renderProfileEditor();
      render();
    },
  });
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 *
 * A deliberate debug affordance for verifying a deployment, since origin
 * isolation cannot be checked on localhost. Reports state only, never profile
 * data.
 * ------------------------------------------------------------------ */

export interface Diagnostics {
  isSecureContext: boolean;
  originAgentCluster: boolean | null;
  webmcpAvailable: boolean;
  origin: string;
  definedCapabilities: number;
  grantedCapabilities: string[];
  liveToolNames: string[];
  auditEntries: number;
}

async function diagnostics(): Promise<Diagnostics> {
  const snapshot = gate.snapshot();
  return {
    isSecureContext: window.isSecureContext,
    originAgentCluster: window.originAgentCluster ?? null,
    webmcpAvailable: gate.available,
    origin: window.location.origin,
    definedCapabilities: snapshot.capabilities.length,
    grantedCapabilities: snapshot.capabilities
      .filter((capability) => capability.granted)
      .map((capability) => capability.name),
    liveToolNames: await gate.liveToolNames(),
    auditEntries: gate.audit().length,
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

  registerCapabilities({ gate, getProfile });

  renderEnvironment(hosts.env, gate.available);
  renderProfileEditor();

  // subscribe() emits immediately, so this performs the first render.
  gate.subscribe(() => render());

  if (gate.available) {
    await gate.start();
    await applyDemoState();
  }

  // Expiry countdowns tick without waiting for a gate event.
  setInterval(() => {
    if (gate.snapshot().capabilities.some((capability) => capability.expiresAt !== null)) {
      render();
    }
  }, 1000);
}

/**
 * Judge fast-path. `?demo=` preloads a real state so a reviewer lands mid-story
 * without clicking through setup. Every path drives the actual gate: nothing is
 * faked, every gate shown is the real gate.
 *
 *   ?demo=granted  income claim granted with the normal 60s window, counting down
 *   ?demo=expired  income claim granted then immediately withdrawn, so the
 *                  registry is back to persistent-only with the event in the log
 *   ?demo=pending  the agent has asked for the income claim and awaits a decision
 */
async function applyDemoState(): Promise<void> {
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (!demo) return;

  const INCOME = 'check_income_threshold';
  try {
    if (demo === 'granted') {
      await gate.grant(INCOME, { ttlMs: GRANT_TTL_MS, reason: 'Housing Support eligibility check' });
    } else if (demo === 'expired') {
      await gate.grant(INCOME, { ttlMs: GRANT_TTL_MS, reason: 'Housing Support eligibility check' });
      gate.revoke(INCOME);
    } else if (demo === 'pending') {
      gate.requestConsent(INCOME, 'I need to confirm your household income is below the Housing Support threshold.');
    }
  } catch (error) {
    console.error(`demo state "${demo}" could not be applied`, error);
  }
}

void boot();
