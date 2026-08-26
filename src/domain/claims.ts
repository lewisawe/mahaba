/**
 * Claims: the atomic units of consent.
 *
 * One claim is one capability is one WebMCP tool. A claim answers a comparison
 * against the profile and returns a boolean plus a restatement of what was
 * asked. It never returns the underlying value.
 *
 * Because Chrome does not enforce inputSchema, each claim validates its own
 * arguments. See probe/FINDINGS.md.
 */

import { ageFrom, type Profile } from './profile';

export const CLAIM_IDS = [
  'income_threshold',
  'age_requirement',
  'household_size',
  'residency',
  'tenure_status',
] as const;

export type ClaimId = (typeof CLAIM_IDS)[number];

/** Tool name for a claim, `check_` prefixed so intent reads clearly to an agent. */
export const toolNameFor = (claim: ClaimId): string => `check_${claim}`;

export interface ClaimAnswer {
  /** Whether the requirement is satisfied. */
  satisfied: boolean;
  /** Restatement of the question answered. Safe to log and display. */
  claim: string;
}

export interface ClaimSpec<Input = unknown> {
  id: ClaimId;
  /** Shown in the consent UI. */
  label: string;
  /** What the agent can and cannot infer, shown beside the consent control. */
  discloses: string;
  /** Tool description the agent reads. */
  description: string;
  inputSchema: object;
  validate: (raw: unknown) => Input;
  answer: (profile: Profile, input: Input) => ClaimAnswer;
  summarize: (input: Input) => string;
}

/**
 * Erases the input type so claims of differing shapes share one registry, while
 * each definition stays internally type-checked. The cast is contained here
 * rather than spread across every claim.
 */
function defineClaim<Input>(spec: ClaimSpec<Input>): ClaimSpec {
  return spec as ClaimSpec;
}

/* ------------------------------------------------------------------ *
 * Argument validation
 * ------------------------------------------------------------------ */

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object of arguments');
  }
  return raw as Record<string, unknown>;
}

function requireInteger(raw: unknown, field: string, min: number, max: number): number {
  const value = asRecord(raw)[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${field}" must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`"${field}" must be a whole number`);
  }
  if (value < min || value > max) {
    throw new Error(`"${field}" must be between ${min} and ${max}`);
  }
  return value;
}

function requireStringList(raw: unknown, field: string, allowed?: readonly string[]): string[] {
  const value = asRecord(raw)[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"${field}" must be a non-empty array of strings`);
  }
  if (value.length > 20) {
    throw new Error(`"${field}" must contain at most 20 entries`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`"${field}" must contain only non-empty strings`);
    }
    const normalised = item.trim().toLowerCase();
    if (allowed && !allowed.includes(normalised)) {
      throw new Error(`"${field}" may only contain ${allowed.join(', ')}`);
    }
    return normalised;
  });
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export const CLAIMS: Record<ClaimId, ClaimSpec> = {
  income_threshold: defineClaim<{ threshold: number }>({
    id: 'income_threshold',
    label: 'Income below a threshold',
    discloses:
      'The agent learns only whether income falls under a number it names. It cannot learn the income.',
    description:
      "Answer whether this household's annual income is below a given threshold. Returns only true or false. The income itself is never returned and cannot be requested.",
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'integer', description: 'Annual household income threshold in whole pounds.' },
      },
      required: ['threshold'],
      additionalProperties: false,
    },
    validate: (raw) => ({ threshold: requireInteger(raw, 'threshold', 0, 10_000_000) }),
    answer: (profile, { threshold }) => ({
      satisfied: profile.annualIncome < threshold,
      claim: `annual income below ${threshold}`,
    }),
    summarize: ({ threshold }) => `compared income against ${threshold}`,
  }),

  age_requirement: defineClaim<{ minimumAge: number }>({
    id: 'age_requirement',
    label: 'Meets a minimum age',
    discloses:
      'The agent learns only whether age clears a minimum it names. It cannot learn the age or date of birth.',
    description:
      'Answer whether this person meets a minimum age requirement. Returns only true or false. Neither the exact age nor the date of birth is ever returned.',
    inputSchema: {
      type: 'object',
      properties: {
        minimumAge: { type: 'integer', description: 'Minimum age in whole years.' },
      },
      required: ['minimumAge'],
      additionalProperties: false,
    },
    validate: (raw) => ({ minimumAge: requireInteger(raw, 'minimumAge', 0, 130) }),
    answer: (profile, { minimumAge }) => ({
      satisfied: ageFrom(profile.dateOfBirth) >= minimumAge,
      claim: `at least ${minimumAge} years old`,
    }),
    summarize: ({ minimumAge }) => `checked age against minimum ${minimumAge}`,
  }),

  household_size: defineClaim<{ minimumSize: number }>({
    id: 'household_size',
    label: 'Household at least a given size',
    discloses:
      'The agent learns only whether the household meets a size it names. It cannot learn how many people live here.',
    description:
      'Answer whether this household has at least a given number of people. Returns only true or false. The household size itself is never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        minimumSize: { type: 'integer', description: 'Minimum number of people in the household.' },
      },
      required: ['minimumSize'],
      additionalProperties: false,
    },
    validate: (raw) => ({ minimumSize: requireInteger(raw, 'minimumSize', 1, 20) }),
    answer: (profile, { minimumSize }) => ({
      satisfied: profile.householdSize >= minimumSize,
      claim: `household of at least ${minimumSize}`,
    }),
    summarize: ({ minimumSize }) => `checked household against minimum ${minimumSize}`,
  }),

  residency: defineClaim<{ districts: string[] }>({
    id: 'residency',
    label: 'Resident in an eligible district',
    discloses:
      'The agent learns only whether this address sits inside a list of districts it names. It cannot learn the district or the address.',
    description:
      'Answer whether this person lives in one of a given list of districts. Returns only true or false. The actual district and address are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        districts: {
          type: 'array',
          items: { type: 'string' },
          description: 'District names to test against.',
        },
      },
      required: ['districts'],
      additionalProperties: false,
    },
    validate: (raw) => ({ districts: requireStringList(raw, 'districts') }),
    answer: (profile, { districts }) => ({
      satisfied: districts.includes(profile.district),
      claim: `resident in one of ${districts.length} listed districts`,
    }),
    summarize: ({ districts }) => `tested residency against ${districts.length} districts`,
  }),

  tenure_status: defineClaim<{ acceptedTenures: string[] }>({
    id: 'tenure_status',
    label: 'Housing tenure is of an accepted kind',
    discloses:
      'The agent learns only whether the tenure is among kinds it names. It cannot learn the tenure, the landlord, or the address.',
    description:
      "Answer whether this household's housing tenure is among a given list of accepted kinds, such as renting or temporary accommodation. Returns only true or false.",
    inputSchema: {
      type: 'object',
      properties: {
        acceptedTenures: {
          type: 'array',
          items: { type: 'string', enum: ['renting', 'owner', 'temporary'] },
          description: 'Tenure kinds that satisfy the requirement.',
        },
      },
      required: ['acceptedTenures'],
      additionalProperties: false,
    },
    validate: (raw) => ({
      acceptedTenures: requireStringList(raw, 'acceptedTenures', ['renting', 'owner', 'temporary']),
    }),
    answer: (profile, { acceptedTenures }) => ({
      satisfied: acceptedTenures.includes(profile.tenure),
      claim: `tenure among ${acceptedTenures.join(', ')}`,
    }),
    summarize: ({ acceptedTenures }) => `tested tenure against ${acceptedTenures.join(', ')}`,
  }),
};

export const claimList = (): ClaimSpec[] => CLAIM_IDS.map((id) => CLAIMS[id]);
