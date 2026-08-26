/**
 * Programs and their requirements.
 *
 * Synthetic. Modelled on the shape of real eligibility rules rather than any
 * actual scheme, so nothing here should be treated as advice.
 *
 * Each requirement names the claim that answers it and the arguments to test.
 * The agent reads these through get_program_requirements, learns which claims it
 * lacks, and asks for those specifically. Requirements are conjunctive: every
 * one must hold.
 */

import type { ClaimId } from './claims';

export interface Requirement {
  claim: ClaimId;
  /** Arguments passed to the claim's tool. */
  args: Record<string, unknown>;
  /** Plain-language statement of the rule, shown in the UI. */
  label: string;
}

export interface Program {
  id: string;
  name: string;
  authority: string;
  summary: string;
  /** Roughly what the programme is worth, for display only. */
  value: string;
  requirements: Requirement[];
}

export const PROGRAMS: Program[] = [
  {
    id: 'housing-support',
    name: 'Housing Support Allowance',
    authority: 'Local Housing Authority',
    summary:
      'Monthly contribution toward rent for lower-income households in priority districts.',
    value: 'up to £320 / month',
    requirements: [
      {
        claim: 'income_threshold',
        args: { threshold: 30_000 },
        label: 'Household income below £30,000',
      },
      {
        claim: 'household_size',
        args: { minimumSize: 3 },
        label: 'Household of 3 or more',
      },
      {
        claim: 'residency',
        args: { districts: ['north', 'east'] },
        label: 'Resident in the north or east district',
      },
      {
        claim: 'tenure_status',
        args: { acceptedTenures: ['renting', 'temporary'] },
        label: 'Renting or in temporary accommodation',
      },
    ],
  },
  {
    id: 'winter-energy',
    name: 'Winter Energy Grant',
    authority: 'Department for Energy Support',
    summary: 'One-off payment toward heating costs over the winter period.',
    value: '£450 one-off',
    requirements: [
      {
        claim: 'income_threshold',
        args: { threshold: 22_000 },
        label: 'Household income below £22,000',
      },
      {
        claim: 'age_requirement',
        args: { minimumAge: 60 },
        label: 'Aged 60 or over',
      },
    ],
  },
  {
    id: 'council-tax-reduction',
    name: 'Council Tax Reduction',
    authority: 'Local Revenue Office',
    summary: 'Reduction of up to 100% on council tax liability for low-income residents.',
    value: 'up to 100% reduction',
    requirements: [
      {
        claim: 'income_threshold',
        args: { threshold: 18_000 },
        label: 'Household income below £18,000',
      },
      {
        claim: 'tenure_status',
        args: { acceptedTenures: ['renting', 'temporary'] },
        label: 'Not an owner-occupier',
      },
    ],
  },
  {
    id: 'childcare-subsidy',
    name: 'Childcare Subsidy',
    authority: 'Family Services',
    summary: 'Subsidised childcare hours for working households with dependants.',
    value: '15 hours / week',
    requirements: [
      {
        claim: 'income_threshold',
        args: { threshold: 45_000 },
        label: 'Household income below £45,000',
      },
      {
        claim: 'household_size',
        args: { minimumSize: 3 },
        label: 'Household of 3 or more',
      },
    ],
  },
  {
    id: 'adult-learning-bursary',
    name: 'Adult Learning Bursary',
    authority: 'Regional Skills Board',
    summary: 'Course fees and materials for adults retraining or returning to study.',
    value: 'up to £1,200 / year',
    requirements: [
      {
        claim: 'income_threshold',
        args: { threshold: 25_000 },
        label: 'Household income below £25,000',
      },
      {
        claim: 'age_requirement',
        args: { minimumAge: 19 },
        label: 'Aged 19 or over',
      },
      {
        claim: 'residency',
        args: { districts: ['north', 'east', 'south', 'west', 'central'] },
        label: 'Resident in the region',
      },
    ],
  },
];

export const programById = (id: string): Program | undefined =>
  PROGRAMS.find((program) => program.id === id);

/** Distinct claims a programme needs, in claim order, without duplicates. */
export function claimsRequiredBy(program: Program): ClaimId[] {
  return [...new Set(program.requirements.map((requirement) => requirement.claim))];
}
