/**
 * Pharmacy instance wiring.
 *
 * Deliberately thin. It reuses the same capability-gate, the same console and
 * consent renderers, and the same DOM helpers as the benefits wallet. The only
 * new code is the pharmacy domain and a small product/shopper view, which is the
 * argument the second instance exists to make: the primitive is reusable, the
 * domain is swappable.
 */

import { createCapabilityGate } from './lib/capability-gate';
import { registerPharmacyCapabilities } from './pharmacy-capabilities';
import {
  loadShopper,
  saveShopper,
  DEFAULT_SHOPPER,
  ageFrom,
  PRODUCTS,
  PHARMACY_CLAIMS,
  toolNameFor,
  type Shopper,
  type Product,
} from './domain/pharmacy';
import { el, mount, replaceChildren } from './ui/dom';
import {
  GRANT_TTL_MS,
  renderCannot,
  renderConsole,
  renderConsoleCount,
  renderPending,
  type ConsentActions,
  type ForbiddenGetter,
} from './ui/consent';
import { renderAudit, renderEnvironment } from './ui/views';

const gate = createCapabilityGate();
let shopper: Shopper = loadShopper();
const getShopper = (): Shopper => shopper;

const hosts = {
  console: mount('console'),
  toolCount: mount('tool-count'),
  cannot: mount('cannot'),
  pending: mount('pending'),
  pendingPanel: mount('pending-panel'),
  products: mount('products'),
  audit: mount('audit'),
  shopper: mount('shopper'),
  env: mount('env'),
};

const consentActions: ConsentActions = {
  grant: async (tool, reason) => {
    try {
      await gate.grant(tool, { ttlMs: GRANT_TTL_MS, reason });
    } catch (error) {
      console.error(`could not grant ${tool}`, error);
      render();
    }
  },
  revoke: (tool) => gate.revoke(tool),
  deny: (tool) => gate.denyConsent(tool),
};

function productCard(product: Product): HTMLElement {
  const assessed = product.requirements.map((r) => {
    const claim = PHARMACY_CLAIMS[r.claim];
    if (!gate.isGranted(toolNameFor(r.claim))) return { label: r.label, status: 'unverified' as const };
    const answer = claim.answer(shopper, claim.validate(r.args));
    return { label: r.label, status: answer.satisfied ? ('met' as const) : ('not_met' as const) };
  });
  const verdict = assessed.some((a) => a.status === 'not_met')
    ? 'ineligible'
    : assessed.some((a) => a.status === 'unverified')
      ? 'undetermined'
      : 'eligible';
  const verdictLabel =
    verdict === 'eligible' ? 'Cleared for checkout' : verdict === 'ineligible' ? 'Blocked' : 'Needs permission to decide';
  const mark = (s: string) => (s === 'met' ? '\u2713' : s === 'not_met' ? '\u2717' : '?');

  return el('article', { class: 'program', data: { verdict } }, [
    el('header', { class: 'program-head' }, [
      el('h3', { class: 'program-name', text: product.name }),
      el('span', { class: 'program-value', text: product.category }),
    ]),
    el('p', { class: 'program-summary', text: product.summary }),
    el('p', { class: 'program-verdict', text: verdictLabel }),
    el(
      'ul',
      { class: 'requirements' },
      assessed.map((a) =>
        el('li', { data: { status: a.status } }, [
          el('span', { class: 'mark', attrs: { 'aria-hidden': 'true' }, text: mark(a.status) }),
          el('span', { text: a.label }),
        ]),
      ),
    ),
  ]);
}

function renderProducts(): void {
  if (!hosts.products) return;
  replaceChildren(hosts.products, ...PRODUCTS.map(productCard));
}

/**
 * Getters an over-parameterized pharmacy would have registered to read the raw
 * fields it holds about a shopper. Derived from the Shopper shape, so the proof
 * names the actual data at risk here (date of birth, medical history), which is
 * a different set from the benefits wallet.
 */
const FORBIDDEN_GETTERS: readonly ForbiddenGetter[] = [
  { tool: 'get_date_of_birth', field: 'date of birth' },
  { tool: 'get_conditions', field: 'medical conditions' },
  { tool: 'get_prescription', field: 'prescription details' },
];

function render(): void {
  const snapshot = gate.snapshot();
  renderConsole(hosts.console, snapshot);
  renderConsoleCount(hosts.toolCount, snapshot);
  renderPending(hosts.pending, snapshot, consentActions);
  if (hosts.pendingPanel) hosts.pendingPanel.hidden = snapshot.pending.length === 0;
  renderProducts();
  renderAudit(hosts.audit, gate.audit());
  void gate.liveToolNames().then((names) => renderCannot(hosts.cannot, names, FORBIDDEN_GETTERS));
}

function renderShopperEditor(): void {
  if (!hosts.shopper) return;
  const dob = el('input', { attrs: { id: 'shopper-dob', type: 'date' } });
  dob.value = shopper.dateOfBirth;
  dob.addEventListener('change', () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob.value)) {
      shopper = { ...shopper, dateOfBirth: dob.value };
      saveShopper(shopper);
      render();
    }
  });

  const rx = el('input', { attrs: { id: 'shopper-rx', type: 'checkbox' } });
  rx.checked = shopper.hasPrescription;
  rx.addEventListener('change', () => {
    shopper = { ...shopper, hasPrescription: rx.checked };
    saveShopper(shopper);
    render();
  });

  const reset = el('button', { class: 'reset', text: 'Reset to defaults' });
  reset.type = 'button';
  reset.addEventListener('click', () => {
    shopper = { ...DEFAULT_SHOPPER };
    saveShopper(shopper);
    renderShopperEditor();
    render();
  });

  replaceChildren(
    hosts.shopper,
    el('div', { class: 'fields' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', attrs: { for: 'shopper-dob' } }, [document.createTextNode('Date of birth')]),
        dob,
        el('p', { class: 'field-hint', text: `Currently ${ageFrom(shopper.dateOfBirth)} years old. No tool can read this.` }),
      ]),
      el('div', { class: 'field field-inline' }, [
        rx,
        el('label', { class: 'field-label', attrs: { for: 'shopper-rx' } }, [
          document.createTextNode('Valid prescription on file'),
        ]),
      ]),
    ]),
    reset,
  );
}

async function applyDemoState(): Promise<void> {
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (!demo) return;
  const AGE = 'check_age_over';
  try {
    if (demo === 'granted') await gate.grant(AGE, { ttlMs: GRANT_TTL_MS, reason: 'Age check for a restricted product' });
    else if (demo === 'expired') {
      await gate.grant(AGE, { ttlMs: GRANT_TTL_MS, reason: 'Age check for a restricted product' });
      gate.revoke(AGE);
    } else if (demo === 'pending')
      gate.requestConsent(AGE, 'I need to confirm you are over 18 for this restricted medicine.');
  } catch (error) {
    console.error(`demo state "${demo}" could not be applied`, error);
  }
}

async function boot(): Promise<void> {
  registerPharmacyCapabilities({ gate, getShopper });
  renderEnvironment(hosts.env, gate.available);
  renderShopperEditor();
  gate.subscribe(() => render());
  if (gate.available) {
    await gate.start();
    await applyDemoState();
  }
  setInterval(() => {
    if (gate.snapshot().capabilities.some((c) => c.expiresAt !== null)) render();
  }, 1000);
}

void boot();
