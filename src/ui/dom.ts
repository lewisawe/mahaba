/**
 * Small DOM helpers.
 *
 * Everything here sets textContent and never innerHTML. Tool arguments and
 * reasons written by an agent end up on screen, and an agent is an untrusted
 * input source: the WebMCP spec calls this out directly in its prompt-injection
 * section. Building nodes rather than parsing strings removes the injection path
 * entirely.
 */

export type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  class?: string;
  text?: string;
  title?: string;
  data?: Record<string, string | undefined>;
  attrs?: Record<string, string | undefined>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;

  for (const [key, value] of Object.entries(options.data ?? {})) {
    if (value !== undefined) node.dataset[key] = value;
  }
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(
  label: string,
  onClick: () => void | Promise<void>,
  options: ElementOptions & { disabled?: boolean; variant?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    ...(options.class === undefined ? {} : { class: options.class }),
    text: label,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.data === undefined ? {} : { data: options.data }),
  });
  node.type = 'button';
  if (options.variant) node.dataset.variant = options.variant;
  if (options.disabled) node.disabled = true;
  node.addEventListener('click', () => {
    void onClick();
  });
  return node;
}

export function replaceChildren(host: Element | null, ...children: Child[]): void {
  if (!host) return;
  host.textContent = '';
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    host.append(child);
  }
}

export function mount(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** Seconds remaining until an epoch timestamp, floored at zero. */
export function secondsUntil(epochMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((epochMs - now) / 1000));
}
