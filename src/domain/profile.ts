/**
 * The person's data.
 *
 * Synthetic throughout. It lives in this browser, in localStorage, and no tool
 * ever returns any field from it. Tools answer comparisons against it.
 */

export type Tenure = 'renting' | 'owner' | 'temporary';

export interface Profile {
  /** Annual household income in whole pounds. */
  annualIncome: number;
  /** ISO date, YYYY-MM-DD. Stored rather than age so it does not drift. */
  dateOfBirth: string;
  householdSize: number;
  district: string;
  tenure: Tenure;
  /** Whether the household already receives any means-tested support. */
  receivingSupport: boolean;
}

export const DISTRICTS = ['north', 'east', 'south', 'west', 'central'] as const;
export const TENURES: readonly Tenure[] = ['renting', 'owner', 'temporary'];

export const DEFAULT_PROFILE: Profile = {
  annualIncome: 24_000,
  dateOfBirth: '1991-04-17',
  householdSize: 4,
  district: 'north',
  tenure: 'renting',
  receivingSupport: false,
};

const STORAGE_KEY = 'mahaba:profile:v1';

/** Whole years elapsed, counting only birthdays that have already passed. */
export function ageFrom(dateOfBirth: string, now: Date = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return 0;
  let age = now.getFullYear() - dob.getFullYear();
  const monthDelta = now.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < dob.getDate())) age -= 1;
  return Math.max(0, age);
}

function isTenure(value: unknown): value is Tenure {
  return typeof value === 'string' && (TENURES as readonly string[]).includes(value);
}

/**
 * Coerce unknown storage content into a Profile, falling back field by field.
 *
 * Anything persisted can be edited or corrupted by hand, so nothing here trusts
 * the stored shape.
 */
export function parseProfile(raw: unknown): Profile {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PROFILE };
  const input = raw as Record<string, unknown>;

  const number = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  const dateOfBirth =
    typeof input.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)
      ? input.dateOfBirth
      : DEFAULT_PROFILE.dateOfBirth;

  return {
    annualIncome: number(input.annualIncome, DEFAULT_PROFILE.annualIncome, 0, 10_000_000),
    dateOfBirth,
    householdSize: number(input.householdSize, DEFAULT_PROFILE.householdSize, 1, 20),
    district:
      typeof input.district === 'string' && input.district.trim() !== ''
        ? input.district.trim().toLowerCase()
        : DEFAULT_PROFILE.district,
    tenure: isTenure(input.tenure) ? input.tenure : DEFAULT_PROFILE.tenure,
    receivingSupport:
      typeof input.receivingSupport === 'boolean'
        ? input.receivingSupport
        : DEFAULT_PROFILE.receivingSupport,
  };
}

export function loadProfile(): Profile {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PROFILE };
    return parseProfile(JSON.parse(stored));
  } catch {
    // Private mode, disabled storage, or malformed JSON. Defaults are fine.
    return { ...DEFAULT_PROFILE };
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Persistence is a convenience, not a requirement.
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
