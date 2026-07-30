import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, fromDefinition, toDefinitionInput, type FormState } from './definition-form';
import type { Definition, DefinitionInput } from '../api/types';

/**
 * The two contract properties the create/edit forms are built on.
 *
 * Both are invariants of API.md rather than of this app, which is exactly why
 * they are worth pinning here: if the contract moves, this fails at the
 * boundary instead of as a 422 in front of an operator.
 */

const EFFECTIVE: Definition = {
  apiVersion: 'mcorch.dev/v1alpha1',
  kind: 'PaperServer',
  metadata: { name: 'survival-01' },
  spec: {
    image: 'docker.io/itzg/minecraft-server:2026.6.1',
    paper: { minecraftVersion: '1.21.8' },
    eulaAccepted: true,
    maxPlayers: 20,
    network: { port: 25565 },
    resources: { memory: '4Gi', heap: { max: '3276Mi', min: '3276Mi' } },
    storage: { mode: 'persistent', mountPath: '/data', volume: { name: 'survival-01' } },
    lifecycle: {
      drain: { policy: 'waitForZeroPlayers', playerTransferTimeout: '2m', saveTimeout: '3m' },
      stopGracePeriod: '4m',
      startupTimeout: '5m',
    },
  },
};

describe('the §14 round-trip claim', () => {
  it('accepts a fetched definition as input with no cast', () => {
    // §14: "Absent optional fields are OMITTED, not null — which is precisely
    // what makes it assignable to DefinitionInput, so a fetched definition can
    // be edited and PUT back with no cast and no rebuild."
    //
    // This assignment is the test. If `Definition` ever stops satisfying
    // `DefinitionInput`, this file stops compiling.
    const draft: DefinitionInput = EFFECTIVE;
    expect(draft.metadata.name).toBe('survival-01');
  });

  it('survives a load-edit-send cycle without inventing or dropping fields', () => {
    const loaded = fromDefinition(EFFECTIVE);
    const sent = toDefinitionInput(loaded);
    expect(sent.spec.image).toBe(EFFECTIVE.spec.image);
    expect(sent.spec.maxPlayers).toBe(20);
    expect(sent.spec.storage).toEqual({
      mode: 'persistent',
      mountPath: '/data',
      volume: { name: 'survival-01' },
    });
    expect(sent.spec.lifecycle?.drain?.saveTimeout).toBe('3m');
    // `build` was never set, so it must not reappear as anything.
    expect(JSON.parse(JSON.stringify(sent)).spec.paper).toEqual({ minecraftVersion: '1.21.8' });
  });
});

describe('the §6 null policy', () => {
  /** A form with only the fields the parser cannot default. */
  function minimalForm(): FormState {
    const values = { ...EMPTY_FORM.values };
    values['metadata.name'] = 'dash-test-01';
    values['spec.image'] = 'docker.io/itzg/minecraft-server:2026.6.1';
    values['spec.paper.minecraftVersion'] = '1.21.8';
    values['spec.resources.memory'] = '2Gi';
    return { ...EMPTY_FORM, values, eulaAccepted: true };
  }

  it('omits unset optional fields rather than sending them as null', () => {
    // §6/§14: the schema treats an explicit `null` as a violation, not as
    // "unset". A single stray null is a 422 the operator cannot act on, so the
    // serialised document is what gets asserted — not the object.
    const wire = JSON.stringify(toDefinitionInput(minimalForm()));
    expect(wire).not.toContain('null');

    const parsed = JSON.parse(wire) as Record<string, unknown>;
    const spec = (parsed.spec ?? {}) as Record<string, unknown>;
    expect(spec).not.toHaveProperty('maxPlayers');
    expect(spec).not.toHaveProperty('network');
    expect(spec).not.toHaveProperty('lifecycle');
    expect(spec).not.toHaveProperty('placement');
    expect((spec.resources as Record<string, unknown>)).not.toHaveProperty('heap');
    expect((spec.resources as Record<string, unknown>).memory).toBe('2Gi');
  });

  it('never sends ephemeral storage by accident', () => {
    // Invariant: world data gets a persistent volume unless somebody asks for
    // otherwise. `persistent` is the form's default and the parser's, so the
    // dangerous value can only appear if it was chosen.
    const asPersistent = JSON.parse(JSON.stringify(toDefinitionInput(minimalForm())));
    expect(asPersistent.spec.storage.mode).toBe('persistent');

    const chosen = toDefinitionInput({ ...minimalForm(), storageMode: 'ephemeral' });
    expect(chosen.spec.storage?.mode).toBe('ephemeral');
    // §14: `volume` must NOT be set on an ephemeral document — a 422 if it is.
    expect(JSON.parse(JSON.stringify(chosen)).spec.storage).not.toHaveProperty('volume');
  });

  it('sends the unticked EULA as false so the violation lands on its checkbox', () => {
    // Omitting it would also be a 422, but `false` is what the operator
    // actually left there, and it is what makes the API attach the problem to
    // `spec.eulaAccepted` rather than to the document as a whole.
    const draft = toDefinitionInput({ ...minimalForm(), eulaAccepted: false });
    expect(draft.spec.eulaAccepted).toBe(false);
  });
});
