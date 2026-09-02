/**
 * Programme cards, the profile editor, and the disclosure log.
 */

import type { AuditEntry, GateSnapshot } from '../lib/capability-gate';
import { CLAIMS, toolNameFor } from '../domain/claims';
import { PROGRAMS, type Program } from '../domain/programs';
import { ageFrom, DISTRICTS, TENURES, type Profile, type Tenure } from '../domain/profile';
import { el, replaceChildren } from './dom';

/* ------------------------------------------------------------------ *
 * Programmes
 * ------------------------------------------------------------------ */

type RequirementStatus = 'met' | 'not_met' | 'unverified';

interface EvaluatedRequirement {
  label: string;
  status: RequirementStatus;
}

/**
 * Evaluate a programme the way the agent would: a requirement can only be
 * decided if its claim is currently permitted. Unpermitted requirements stay
 * unverified rather than silently resolving, which is the honest rendering of
 * what is knowable.
 */
export function evaluateProgram(
  program: Program,
  profile: Profile,
  isGranted: (tool: string) => boolean,
): { requirements: EvaluatedRequirement[]; verdict: 'eligible' | 'ineligible' | 'undetermined' } {
  const requirements = program.requirements.map((requirement) => {
    const claim = CLAIMS[requirement.claim];
    if (!isGranted(toolNameFor(requirement.claim))) {
      return { label: requirement.label, status: 'unverified' as const };
    }
    const answer = claim.answer(profile, claim.validate(requirement.args));
    return {
      label: requirement.label,
      status: answer.satisfied ? ('met' as const) : ('not_met' as const),
    };
  });

  const verdict = requirements.some((r) => r.status === 'not_met')
    ? 'ineligible'
    : requirements.some((r) => r.status === 'unverified')
      ? 'undetermined'
      : 'eligible';

  return { requirements, verdict };
}

const VERDICT_LABEL: Record<'eligible' | 'ineligible' | 'undetermined', string> = {
  eligible: 'All requirements verified',
  ineligible: 'Not eligible',
  undetermined: 'Needs permission to decide',
};

const STATUS_MARK: Record<RequirementStatus, string> = {
  met: '\u2713',
  not_met: '\u2717',
  unverified: '?',
};

function programCard(
  program: Program,
  profile: Profile,
  isGranted: (tool: string) => boolean,
): HTMLElement {
  const { requirements, verdict } = evaluateProgram(program, profile, isGranted);

  return el('article', { class: 'program', data: { verdict } }, [
    el('header', { class: 'program-head' }, [
      el('h3', { class: 'program-name', text: program.name }),
      el('span', { class: 'program-value', text: program.value }),
    ]),
    el('p', { class: 'program-authority', text: program.authority }),
    el('p', { class: 'program-summary', text: program.summary }),
    el('p', { class: 'program-verdict', text: VERDICT_LABEL[verdict] }),
    el(
      'ul',
      { class: 'requirements' },
      requirements.map((requirement) =>
        el('li', { data: { status: requirement.status } }, [
          el('span', { class: 'mark', attrs: { 'aria-hidden': 'true' }, text: STATUS_MARK[requirement.status] }),
          el('span', { text: requirement.label }),
          el('span', {
            class: 'sr-only',
            text:
              requirement.status === 'met'
                ? ' (verified as met)'
                : requirement.status === 'not_met'
                  ? ' (not met)'
                  : ' (cannot be checked without permission)',
          }),
        ]),
      ),
    ),
  ]);
}

export function renderPrograms(
  host: HTMLElement | null,
  profile: Profile,
  isGranted: (tool: string) => boolean,
): void {
  if (!host) return;
  replaceChildren(host, ...PROGRAMS.map((program) => programCard(program, profile, isGranted)));
}

/* ------------------------------------------------------------------ *
 * Profile editor
 * ------------------------------------------------------------------ */

export interface ProfileActions {
  update: (patch: Partial<Profile>) => void;
  reset: () => void;
}

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', attrs: { for: control.id } }, [
      document.createTextNode(labelText),
    ]),
    control,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

function numberInput(
  id: string,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
): HTMLInputElement {
  const input = el('input', { attrs: { id, type: 'number', min: String(min), max: String(max), inputmode: 'numeric' } });
  input.value = String(value);
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    input.value = String(clamped);
    onChange(clamped);
  });
  return input;
}

function selectInput(
  id: string,
  options: readonly string[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = el('select', { attrs: { id } });
  for (const option of options) {
    const node = el('option', { text: option, attrs: { value: option } });
    if (option === value) node.selected = true;
    select.append(node);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function renderProfile(
  host: HTMLElement | null,
  profile: Profile,
  actions: ProfileActions,
): void {
  if (!host) return;

  const dob = el('input', { attrs: { id: 'profile-dob', type: 'date' } });
  dob.value = profile.dateOfBirth;
  dob.addEventListener('change', () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob.value)) actions.update({ dateOfBirth: dob.value });
  });

  const support = el('input', { attrs: { id: 'profile-support', type: 'checkbox' } });
  support.checked = profile.receivingSupport;
  support.addEventListener('change', () => actions.update({ receivingSupport: support.checked }));

  const reset = el('button', { class: 'reset', text: 'Reset to defaults' });
  reset.type = 'button';
  reset.addEventListener('click', () => actions.reset());

  replaceChildren(
    host,
    el('div', { class: 'fields' }, [
      field(
        'Annual household income',
        numberInput('profile-income', profile.annualIncome, 0, 10_000_000, (value) =>
          actions.update({ annualIncome: value }),
        ),
        'No tool can read this. Claims compare against it.',
      ),
      field(
        'Date of birth',
        dob,
        `Currently ${ageFrom(profile.dateOfBirth)} years old.`,
      ),
      field(
        'People in household',
        numberInput('profile-household', profile.householdSize, 1, 20, (value) =>
          actions.update({ householdSize: value }),
        ),
      ),
      field(
        'District',
        selectInput('profile-district', DISTRICTS, profile.district, (value) =>
          actions.update({ district: value }),
        ),
      ),
      field(
        'Housing tenure',
        selectInput('profile-tenure', TENURES, profile.tenure, (value) =>
          actions.update({ tenure: value as Tenure }),
        ),
      ),
      el('div', { class: 'field field-inline' }, [
        support,
        el('label', { class: 'field-label', attrs: { for: 'profile-support' } }, [
          document.createTextNode('Already receiving means-tested support'),
        ]),
      ]),
    ]),
    reset,
  );
}

/* ------------------------------------------------------------------ *
 * Disclosure log
 * ------------------------------------------------------------------ */

function describe(entry: AuditEntry): string {
  switch (entry.type) {
    case 'granted':
      return `${entry.name}${entry.ttlMs === null ? '' : ` for ${Math.round(entry.ttlMs / 1000)}s`}${entry.reason ? ` — ${entry.reason}` : ''}`;
    case 'revoked':
      return `${entry.name} (${entry.cause})`;
    case 'called':
      return entry.summary;
    case 'denied':
      return `${entry.name}: ${entry.message}`;
    case 'requested':
      return `${entry.name} — ${entry.reason}`;
    case 'declined':
      return `${entry.name} (declined by you)`;
  }
}

export function renderAudit(host: HTMLElement | null, entries: readonly AuditEntry[]): void {
  if (!host) return;

  const rows = entries
    .slice(-60)
    .reverse()
    .map((entry) => {
      const at = new Date(entry.at);
      const time = el('time', { text: at.toLocaleTimeString([], { hour12: false }) });
      time.dateTime = at.toISOString();
      return el('li', { data: { type: entry.type } }, [
        time,
        el('span', { class: 'tag', text: entry.type }),
        el('span', { class: 'entry-detail', text: describe(entry) }),
      ]);
    });

  replaceChildren(host, ...rows);
}

/* ------------------------------------------------------------------ *
 * Environment panel
 * ------------------------------------------------------------------ */

export function renderEnvironment(host: HTMLElement | null, available: boolean): void {
  if (!host) return;

  const rows: Array<[string, string, 'good' | 'bad' | 'plain']> = [
    ['isSecureContext', String(window.isSecureContext), window.isSecureContext ? 'good' : 'bad'],
    [
      'originAgentCluster',
      String(window.originAgentCluster ?? '(unsupported)'),
      window.originAgentCluster === true ? 'good' : 'bad',
    ],
    ['document.modelContext', available ? 'present' : 'missing', available ? 'good' : 'bad'],
  ];

  const nodes = rows.map(([label, value, state]) =>
    el('div', {}, [
      el('dt', { text: label }),
      el('dd', { text: value, data: state === 'plain' ? {} : { state } }),
    ]),
  );

  if (!available) {
    nodes.push(
      el('div', {}, [
        el('dt', { text: 'to enable' }),
        el('dd', {
          data: { state: 'bad' },
          text: 'Open in the ChatGPT in-app browser, or enable chrome://flags/#enable-webmcp-testing',
        }),
      ]),
    );
  }

  replaceChildren(host, ...nodes);
}

/** Unused snapshot parameter kept out; consumers pass what they need. */
export type { GateSnapshot };
