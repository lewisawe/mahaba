/**
 * Pharmacy instance capability registration.
 *
 * The same three-tier shape as the benefits wallet, on the same capability-gate,
 * with a pharmacy claim set. This is the whole point of the second instance: the
 * primitive does not change, only the domain does.
 */

import type { CapabilityGate } from './lib/capability-gate';
import {
  PHARMACY_CLAIMS,
  PHARMACY_CLAIM_IDS,
  toolNameFor,
  PRODUCTS,
  productById,
  type Shopper,
} from './domain/pharmacy';

export interface RegisterOptions {
  gate: CapabilityGate;
  getShopper: () => Shopper;
}

export const CHECKOUT_TOOL = 'prepare_checkout';

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object of arguments');
  }
  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, field: string): string {
  const value = asRecord(raw)[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${field}" must be a non-empty string`);
  return value.trim();
}

function resolveClaimId(value: string): (typeof PHARMACY_CLAIM_IDS)[number] {
  const direct = PHARMACY_CLAIM_IDS.find((id) => id === value);
  if (direct) return direct;
  const byTool = PHARMACY_CLAIM_IDS.find((id) => toolNameFor(id) === value);
  if (byTool) return byTool;
  throw new Error(`unknown claim "${value}". Valid: ${PHARMACY_CLAIM_IDS.join(', ')}`);
}

export function registerPharmacyCapabilities({ gate, getShopper }: RegisterOptions): void {
  gate.define('list_products', {
    description:
      'List the restricted pharmacy products this checkout can gate. Returns identifiers, names and categories. Discloses nothing about the shopper.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: () => ({
      products: PRODUCTS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        summary: p.summary,
        requirementCount: p.requirements.length,
      })),
    }),
  });

  gate.define('get_product_requirements', {
    description:
      'For one product, list every gate it applies, the claim that answers it, and whether that claim is currently permitted.',
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string', description: 'Product identifier from list_products.' } },
      required: ['productId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: (raw) => ({ productId: requireString(raw, 'productId') }),
    execute: ({ productId }) => {
      const product = productById(productId);
      if (!product) throw new Error(`unknown productId "${productId}". Call list_products.`);
      return {
        productId: product.id,
        name: product.name,
        requirements: product.requirements.map((r) => ({
          rule: r.label,
          claim: r.claim,
          tool: toolNameFor(r.claim),
          arguments: r.args,
          permitted: gate.isGranted(toolNameFor(r.claim)),
        })),
      };
    },
  });

  gate.define('get_consent_state', {
    description:
      'Report which claims this shopper currently permits and which are unavailable. An unavailable claim has no tool, so it cannot be called.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: () => {
      const { capabilities, pending } = gate.snapshot();
      return {
        permitted: capabilities.filter((c) => c.granted && !c.persistent).map((c) => c.name),
        unavailable: capabilities.filter((c) => !c.granted).map((c) => ({ tool: c.name, describes: c.description })),
        awaitingDecision: pending.map((r) => r.name),
      };
    },
  });

  gate.define('request_consent', {
    description:
      'Ask this shopper to permit a claim you do not currently have. State plainly why. Returns immediately; call get_consent_state afterwards to see the outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: `Claim or tool name. One of: ${PHARMACY_CLAIM_IDS.join(', ')}` },
        reason: { type: 'string', description: 'Why this claim is needed, shown to the shopper verbatim.' },
      },
      required: ['claim', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    persistent: true,
    validate: (raw) => ({ claim: requireString(raw, 'claim'), reason: requireString(raw, 'reason') }),
    execute: ({ claim, reason }) => {
      const claimId = resolveClaimId(claim);
      const tool = toolNameFor(claimId);
      if (gate.isGranted(tool)) return { status: 'already_permitted' as const, tool };
      gate.requestConsent(tool, reason);
      return { status: 'awaiting_decision' as const, tool };
    },
    summarize: ({ claim, reason }) => `asked for ${claim}: ${reason}`,
  });

  gate.define('get_disclosure_receipt', {
    description:
      'Return the append-only record of what has been disclosed in this session. Contains no personal values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    persistent: true,
    validate: () => ({}),
    execute: () => ({
      entries: gate.audit().map((entry) => ({
        type: entry.type,
        at: new Date(entry.at).toISOString(),
        detail:
          entry.type === 'called'
            ? entry.summary
            : entry.type === 'denied'
              ? `${entry.name}: ${entry.message}`
              : entry.name,
      })),
    }),
  });

  for (const claimId of PHARMACY_CLAIM_IDS) {
    const claim = PHARMACY_CLAIMS[claimId];
    gate.define(toolNameFor(claimId), {
      title: claim.label,
      description: claim.description,
      inputSchema: claim.inputSchema,
      annotations: { readOnlyHint: true },
      validate: claim.validate,
      execute: (input) => {
        const answer = claim.answer(getShopper(), input);
        return { satisfied: answer.satisfied, claim: answer.claim };
      },
      summarize: (input) => claim.summarize(input),
    });
  }

  gate.define(CHECKOUT_TOOL, {
    description:
      'Authorise checkout for a product, citing only the claims that were verified. Requires separate permission because it commits the purchase. Never includes personal values.',
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string', description: 'Product identifier from list_products.' } },
      required: ['productId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    validate: (raw) => ({ productId: requireString(raw, 'productId') }),
    execute: ({ productId }) => {
      const product = productById(productId);
      if (!product) throw new Error(`unknown productId "${productId}". Call list_products.`);
      const shopper = getShopper();
      const assertions = product.requirements.map((r) => {
        const claim = PHARMACY_CLAIMS[r.claim];
        if (!gate.isGranted(toolNameFor(r.claim))) return { rule: r.label, status: 'unverified' as const };
        const answer = claim.answer(shopper, claim.validate(r.args));
        return {
          rule: r.label,
          status: answer.satisfied ? ('met' as const) : ('not_met' as const),
          assertedClaim: answer.claim,
        };
      });
      const blocked = assertions.filter((a) => a.status !== 'met').length;
      return {
        productId: product.id,
        productName: product.name,
        assertions,
        authorised: blocked === 0,
        note: blocked === 0 ? 'All gates cleared by permitted claims.' : `${blocked} gate(s) not cleared.`,
      };
    },
    summarize: ({ productId }) => `authorised checkout for ${productId}`,
  });
}
