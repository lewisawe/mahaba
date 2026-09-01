/**
 * Second instance: an age- and eligibility-gated pharmacy checkout.
 *
 * This exists to prove one thing: capability-gate is a primitive, not a feature
 * of the benefits wallet. The same gate, the same console, the same consent
 * loop, a completely different domain. Only the claims and the catalogue change.
 *
 * A pharmacy needs to know whether a buyer clears an age threshold and whether a
 * product is safe against their conditions. It does not need the date of birth
 * or the medical history to answer that, and here it cannot ask for them: the
 * claims compare, they never reveal.
 *
 * Synthetic throughout. Not medical or pharmacy advice.
 */

export interface Shopper {
  /** ISO date, YYYY-MM-DD. */
  dateOfBirth: string;
  /** Conditions the shopper has, as lowercase tags. Never returned by any tool. */
  conditions: string[];
  /** Whether the shopper holds a valid prescription on file. */
  hasPrescription: boolean;
}

export const CONDITIONS = ['hypertension', 'pregnancy', 'diabetes', 'none'] as const;

export const DEFAULT_SHOPPER: Shopper = {
  dateOfBirth: '2004-02-10',
  conditions: ['hypertension'],
  hasPrescription: false,
};

const STORAGE_KEY = 'proof-not-profile:shopper:v1';

export function ageFrom(dateOfBirth: string, now: Date = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return 0;
  let age = now.getFullYear() - dob.getFullYear();
  const monthDelta = now.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < dob.getDate())) age -= 1;
  return Math.max(0, age);
}

export function parseShopper(raw: unknown): Shopper {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SHOPPER };
  const input = raw as Record<string, unknown>;
  const dateOfBirth =
    typeof input.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)
      ? input.dateOfBirth
      : DEFAULT_SHOPPER.dateOfBirth;
  const conditions = Array.isArray(input.conditions)
    ? input.conditions.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase())
    : [...DEFAULT_SHOPPER.conditions];
  return {
    dateOfBirth,
    conditions,
    hasPrescription:
      typeof input.hasPrescription === 'boolean' ? input.hasPrescription : DEFAULT_SHOPPER.hasPrescription,
  };
}

export function loadShopper(): Shopper {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_SHOPPER };
    return parseShopper(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_SHOPPER };
  }
}

export function saveShopper(shopper: Shopper): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shopper));
  } catch {
    /* persistence is a convenience */
  }
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export interface PharmacyClaimAnswer {
  satisfied: boolean;
  claim: string;
}

export interface PharmacyClaimSpec<Input = unknown> {
  id: string;
  label: string;
  discloses: string;
  description: string;
  inputSchema: object;
  validate: (raw: unknown) => Input;
  answer: (shopper: Shopper, input: Input) => PharmacyClaimAnswer;
  summarize: (input: Input) => string;
}

function defineClaim<Input>(spec: PharmacyClaimSpec<Input>): PharmacyClaimSpec {
  return spec as PharmacyClaimSpec;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object of arguments');
  }
  return raw as Record<string, unknown>;
}

function requireInteger(raw: unknown, field: string, min: number, max: number): number {
  const value = asRecord(raw)[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${field}" must be a finite number`);
  if (!Number.isInteger(value)) throw new Error(`"${field}" must be a whole number`);
  if (value < min || value > max) throw new Error(`"${field}" must be between ${min} and ${max}`);
  return value;
}

function requireStringList(raw: unknown, field: string): string[] {
  const value = asRecord(raw)[field];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`"${field}" must be a non-empty array of strings`);
  if (value.length > 20) throw new Error(`"${field}" must contain at most 20 entries`);
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`"${field}" must contain only non-empty strings`);
    return item.trim().toLowerCase();
  });
}

export const PHARMACY_CLAIM_IDS = ['age_over', 'no_contraindication', 'prescription_on_file'] as const;
export type PharmacyClaimId = (typeof PHARMACY_CLAIM_IDS)[number];
export const toolNameFor = (claim: PharmacyClaimId): string => `check_${claim}`;

export const PHARMACY_CLAIMS: Record<PharmacyClaimId, PharmacyClaimSpec> = {
  age_over: defineClaim<{ minimumAge: number }>({
    id: 'age_over',
    label: 'Meets an age restriction',
    discloses:
      'The agent learns only whether age clears a minimum it names. It cannot learn the age or date of birth.',
    description:
      'Answer whether this shopper meets a minimum age for a restricted product. Returns only true or false. The date of birth is never returned and cannot be requested.',
    inputSchema: {
      type: 'object',
      properties: { minimumAge: { type: 'integer', description: 'Minimum age in whole years.' } },
      required: ['minimumAge'],
      additionalProperties: false,
    },
    validate: (raw) => ({ minimumAge: requireInteger(raw, 'minimumAge', 0, 130) }),
    answer: (shopper, { minimumAge }) => ({
      satisfied: ageFrom(shopper.dateOfBirth) >= minimumAge,
      claim: `at least ${minimumAge} years old`,
    }),
    summarize: ({ minimumAge }) => `checked age against minimum ${minimumAge}`,
  }),

  no_contraindication: defineClaim<{ against: string[] }>({
    id: 'no_contraindication',
    label: 'No listed contraindication',
    discloses:
      'The agent learns only whether the shopper has any of the conditions a product warns against. It cannot learn which conditions the shopper has, or how many.',
    description:
      'Answer whether this shopper is clear of a set of conditions a product is contraindicated against. Returns only true (safe) or false (a contraindication is present). The shopper\u2019s actual conditions are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        against: { type: 'array', items: { type: 'string' }, description: 'Condition tags the product warns against.' },
      },
      required: ['against'],
      additionalProperties: false,
    },
    validate: (raw) => ({ against: requireStringList(raw, 'against') }),
    answer: (shopper, { against }) => ({
      satisfied: !shopper.conditions.some((c) => against.includes(c)),
      claim: `clear of ${against.length} contraindicated condition(s)`,
    }),
    summarize: ({ against }) => `checked for contraindications against ${against.length} condition(s)`,
  }),

  prescription_on_file: defineClaim<Record<string, never>>({
    id: 'prescription_on_file',
    label: 'Valid prescription on file',
    discloses:
      'The agent learns only whether a valid prescription is on file. It cannot learn what it is for.',
    description:
      'Answer whether this shopper has a valid prescription on file for a prescription-only medicine. Returns only true or false.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    validate: () => ({}),
    answer: (shopper) => ({
      satisfied: shopper.hasPrescription,
      claim: 'valid prescription on file',
    }),
    summarize: () => 'checked whether a prescription is on file',
  }),
};

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export interface Requirement {
  claim: PharmacyClaimId;
  args: Record<string, unknown>;
  label: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  summary: string;
  requirements: Requirement[];
}

export const PRODUCTS: Product[] = [
  {
    id: 'cough-syrup',
    name: 'Codeine Cough Syrup',
    category: 'Pharmacy medicine',
    summary: 'Age-restricted over-the-counter cough suppressant.',
    requirements: [
      { claim: 'age_over', args: { minimumAge: 18 }, label: 'Aged 18 or over' },
      {
        claim: 'no_contraindication',
        args: { against: ['pregnancy'] },
        label: 'Not contraindicated (pregnancy)',
      },
    ],
  },
  {
    id: 'blood-pressure',
    name: 'Blood Pressure Medication',
    category: 'Prescription only',
    summary: 'Requires a valid prescription and no conflicting condition.',
    requirements: [
      { claim: 'prescription_on_file', args: {}, label: 'Valid prescription on file' },
      { claim: 'age_over', args: { minimumAge: 18 }, label: 'Aged 18 or over' },
    ],
  },
  {
    id: 'sleep-aid',
    name: 'Strong Sleep Aid',
    category: 'Pharmacy medicine',
    summary: 'Age-restricted, contraindicated against several conditions.',
    requirements: [
      { claim: 'age_over', args: { minimumAge: 18 }, label: 'Aged 18 or over' },
      {
        claim: 'no_contraindication',
        args: { against: ['hypertension', 'pregnancy'] },
        label: 'Not contraindicated (hypertension, pregnancy)',
      },
    ],
  },
];

export const productById = (id: string): Product | undefined => PRODUCTS.find((p) => p.id === id);
