/**
 * A create form pre-filled to land behind a particular proxy.
 *
 * There is exactly one field that decides whether a new server is a backend:
 * its labels. `ProxyFleet.resolve` claims a `PaperServer` when it carries every
 * label in the proxy's `spec.backends.selector.matchLabels`, so the prefill is
 * that selector and nothing else invented around it.
 *
 * What is *not* prefilled matters as much. A backend behind a proxy is meant to
 * stay unpublished — the orchestrator's own troubleshooting notes say so by
 * name: "the proxy is the front door and carries the `hostPort` players type.
 * Publishing a backend directly bypasses the thing that makes drains work." So
 * `spec.network.hostPort` is left blank, which is already the schema's default,
 * and the form says why rather than quietly leaving an empty box that looks like
 * an omission. Everything else — image, version, memory, storage — has no
 * defensible value to derive from the proxy, and guessing one would be a
 * decision taken away from the operator rather than a default handed to them.
 */

import type { ServerResource } from '../api/types';
import { EMPTY_FORM, type FormState } from './definition-form';

/** The selector a proxy enrols backends with, or `null` for any other kind. */
export function backendSelectorOf(proxy: ServerResource): Record<string, string> | null {
  return proxy.definition.kind === 'VelocityProxy'
    ? proxy.definition.spec.backends.selector.matchLabels
    : null;
}

/**
 * `key=value` per line, the shape the labels textarea holds.
 *
 * Sorted by key. The wire order is whatever the store wrote, and a form whose
 * lines reshuffle between visits reads as though something changed.
 */
export function labelLines(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * A `FormState` that will be enrolled by `proxy` the moment it is created.
 *
 * `null` when the resource is not a proxy — there is no selector to copy, and a
 * form pre-filled from nothing would claim a relationship it cannot deliver.
 */
export function backendFormFor(proxy: ServerResource): FormState | null {
  const selector = backendSelectorOf(proxy);
  if (selector === null) return null;
  return {
    ...EMPTY_FORM,
    values: { ...EMPTY_FORM.values },
    labels: labelLines(selector),
  };
}
