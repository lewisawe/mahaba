/**
 * Capability registration.
 *
 * Three tiers:
 *
 *   persistent      Registered at start(). Disclose nothing about the person on
 *                   their own: what programmes exist, what they require, which
 *                   claims are currently permitted, and the disclosure log.
 *
 *   consent-gated   One per claim. These do not exist in the tool registry until
 *                   the person grants them, and vanish when consent is withdrawn
 *                   or expires.
 *
 *   approval-gated  prepare_application_draft. Writes, so it needs its own
 *                   explicit grant separate from any claim.
 *
 * There is deliberately no tool that returns a raw profile value. An agent can
 * learn that income is below a threshold. It has no way to learn the income,
 * because the capability to ask does not exist.
 */

import type { CapabilityGate } from './lib/capability-gate';
import { CLAIMS, CLAIM_IDS, toolNameFor, type ClaimId } from './domain/claims';
import { PROGRAMS, programById, claimsRequiredBy } from './domain/programs';
import type { Profile } from './domain/profile';

export interface RegisterOptions {
  gate: CapabilityGate;
  getProfile: () => Profile;
}

/** Tool name of the write capability that drafts an application. */
export const DRAFT_TOOL = 'prepare_application_draft';

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object of arguments');
  }
  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, field: string): string {
  const value = asRecord(raw)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

/** Map a tool name back to its claim, so consent requests can name either. */
function resolveClaimId(value: string): ClaimId {
  const direct = CLAIM_IDS.find((id) => id === value);
  if (direct) return direct;
  const byTool = CLAIM_IDS.find((id) => toolNameFor(id) === value);
  if (byTool) return byTool;
  throw new Error(
    `unknown claim "${value}". Valid claims are: ${CLAIM_IDS.join(', ')}`,
  );
}

export function registerCapabilities({ gate, getProfile }: RegisterOptions): void {
  /* ---------------- persistent ---------------- */

  gate.define('list_programs', {
    description:
      'List the support programmes this wallet can check eligibility for. Returns programme identifiers, names and summaries. Discloses nothing about the person.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: () => ({
      programs: PROGRAMS.map((program) => ({
        id: program.id,
        name: program.name,
        authority: program.authority,
        summary: program.summary,
        value: program.value,
        requirementCount: program.requirements.length,
      })),
    }),
  });

  gate.define('get_program_requirements', {
    description:
      'For one programme, list every requirement, the claim that answers it, and whether that claim is currently permitted. Call this before attempting checks so you know what consent to ask for.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { type: 'string', description: 'Programme identifier from list_programs.' },
      },
      required: ['programId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: (raw) => ({ programId: requireString(raw, 'programId') }),
    execute: ({ programId }) => {
      const program = programById(programId);
      if (!program) {
        throw new Error(
          `unknown programId "${programId}". Call list_programs for valid identifiers.`,
        );
      }
      return {
        programId: program.id,
        name: program.name,
        requirements: program.requirements.map((requirement) => ({
          rule: requirement.label,
          claim: requirement.claim,
          tool: toolNameFor(requirement.claim),
          arguments: requirement.args,
          permitted: gate.isGranted(toolNameFor(requirement.claim)),
        })),
        missingConsent: claimsRequiredBy(program)
          .filter((claim) => !gate.isGranted(toolNameFor(claim)))
          .map((claim) => ({ claim, tool: toolNameFor(claim) })),
      };
    },
  });

  gate.define('get_consent_state', {
    description:
      'Report which claims this person currently permits and which are unavailable. An unavailable claim has no tool, so it cannot be called. Use request_consent to ask for one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: () => {
      const { capabilities, pending } = gate.snapshot();
      return {
        permitted: capabilities
          .filter((capability) => capability.granted && !capability.persistent)
          .map((capability) => capability.name),
        unavailable: capabilities
          .filter((capability) => !capability.granted)
          .map((capability) => ({ tool: capability.name, describes: capability.description })),
        awaitingDecision: pending.map((request) => request.name),
      };
    },
  });

  gate.define('request_consent', {
    description:
      'Ask this person to permit a claim you do not currently have. State plainly why you need it. Returns immediately without waiting: the person decides in their own time, so call get_consent_state afterwards to see the outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: `Claim or tool name to request. One of: ${CLAIM_IDS.join(', ')}`,
        },
        reason: {
          type: 'string',
          description: 'Why this claim is needed, in one sentence, shown to the person verbatim.',
        },
      },
      required: ['claim', 'reason'],
      additionalProperties: false,
    },
    // Not read-only: it changes what the person is being asked to decide. The
    // reason string is authored by the agent and surfaced verbatim to the
    // person, so it is untrusted content crossing the agent->human boundary.
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    persistent: true,
    validate: (raw) => ({
      claim: requireString(raw, 'claim'),
      reason: requireString(raw, 'reason'),
    }),
    execute: ({ claim, reason }) => {
      const claimId = resolveClaimId(claim);
      const tool = toolNameFor(claimId);
      if (gate.isGranted(tool)) {
        return { status: 'already_permitted' as const, tool };
      }
      gate.requestConsent(tool, reason);
      return {
        status: 'awaiting_decision' as const,
        tool,
        note: 'The person has been asked. Call get_consent_state to see whether it was granted.',
      };
    },
    summarize: ({ claim, reason }) => `asked for ${claim}: ${reason}`,
  });

  gate.define('get_disclosure_receipt', {
    description:
      'Return a signed, verifiable record of what has been disclosed in this session: which claims were permitted, compared, denied and withdrawn. Contains no personal values. The signature is produced server-side and can be re-verified.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: async () => {
      const entries = gate.audit().map((entry) => ({
        type: entry.type,
        at: new Date(entry.at).toISOString(),
        detail:
          entry.type === 'called'
            ? entry.summary
            : entry.type === 'denied'
              ? `${entry.name}: ${entry.message}`
              : entry.name,
      }));

      // Ask the signing function for an HMAC over the entries. The signing key
      // never reaches the browser, so the receipt cannot be forged client-side.
      // If the function is unreachable, still return the entries rather than
      // failing the tool: the record is useful even unsigned, and the agent is
      // told which it got.
      try {
        const response = await fetch('/.netlify/functions/sign-receipt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'sign', entries }),
        });
        if (!response.ok) throw new Error(`signing returned ${response.status}`);
        const signed = (await response.json()) as {
          signature: string;
          algorithm: string;
          receipt: { issuedAt: string; issuer: string };
          verify: string;
        };
        return {
          signed: true,
          issuer: signed.receipt.issuer,
          issuedAt: signed.receipt.issuedAt,
          algorithm: signed.algorithm,
          signature: signed.signature,
          verify: signed.verify,
          entries,
        };
      } catch (error) {
        return {
          signed: false,
          note:
            'Signing service unavailable; returning the unsigned disclosure log. ' +
            (error instanceof Error ? error.message : 'unknown error'),
          entries,
        };
      }
    },
  });

  /* ---------------- consent-gated, one per claim ---------------- */

  for (const claimId of CLAIM_IDS) {
    const claim = CLAIMS[claimId];
    gate.define(toolNameFor(claimId), {
      title: claim.label,
      description: claim.description,
      inputSchema: claim.inputSchema,
      annotations: { readOnlyHint: true },
      validate: claim.validate,
      execute: (input) => {
        const answer = claim.answer(getProfile(), input);
        return { satisfied: answer.satisfied, claim: answer.claim };
      },
      summarize: (input) => claim.summarize(input),
    });
  }

  /* ---------------- approval-gated write ---------------- */

  gate.define(DRAFT_TOOL, {
    description:
      'Draft an application for a programme, citing only the claims that were verified. Requires separate permission because it writes. Never includes personal values.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { type: 'string', description: 'Programme identifier from list_programs.' },
      },
      required: ['programId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    validate: (raw) => ({ programId: requireString(raw, 'programId') }),
    execute: ({ programId }) => {
      const program = programById(programId);
      if (!program) {
        throw new Error(
          `unknown programId "${programId}". Call list_programs for valid identifiers.`,
        );
      }

      const profile = getProfile();
      const assertions = program.requirements.map((requirement) => {
        const claim = CLAIMS[requirement.claim];
        const permitted = gate.isGranted(toolNameFor(requirement.claim));
        if (!permitted) {
          return { rule: requirement.label, status: 'unverified' as const };
        }
        const input = claim.validate(requirement.args);
        const answer = claim.answer(profile, input);
        return {
          rule: requirement.label,
          status: answer.satisfied ? ('met' as const) : ('not_met' as const),
          assertedClaim: answer.claim,
        };
      });

      const unverified = assertions.filter((a) => a.status === 'unverified').length;
      const notMet = assertions.filter((a) => a.status === 'not_met').length;

      return {
        programId: program.id,
        programName: program.name,
        authority: program.authority,
        // The draft carries claims, never values. Nothing here identifies the person.
        assertions,
        readyToSubmit: unverified === 0 && notMet === 0,
        note:
          unverified > 0
            ? `${unverified} requirement(s) could not be verified without further consent.`
            : notMet > 0
              ? `${notMet} requirement(s) are not met.`
              : 'All requirements verified by permitted claims.',
      };
    },
    summarize: ({ programId }) => `drafted an application for ${programId}`,
  });
}
