import { describe, expect, it } from 'vitest';
import {
  buildActivateHandlerSource,
  decideActivation,
} from '../../src/inbound/activate-rule-set.js';

const OURS = 'FreeMailRuleSet';
const FOREIGN = 'SomeoneElsesRuleSet';

describe('decideActivation', () => {
  it('activates ours when no set is active (Create)', () => {
    expect(decideActivation('Create', undefined, OURS)).toEqual({ action: 'activate' });
  });

  it('activates (idempotently) when ours is already active', () => {
    expect(decideActivation('Create', OURS, OURS)).toEqual({ action: 'activate' });
    expect(decideActivation('Update', OURS, OURS)).toEqual({ action: 'activate' });
  });

  it('FAILS SAFE on Create/Update when a different set is active — naming the conflict', () => {
    for (const type of ['Create', 'Update'] as const) {
      expect(() => decideActivation(type, FOREIGN, OURS)).toThrow(FOREIGN);
      // The error must be actionable, not just "conflict".
      expect(() => decideActivation(type, FOREIGN, OURS)).toThrow(/will not override it/);
    }
  });

  it('deactivates ours on Delete only when ours is still active', () => {
    expect(decideActivation('Delete', OURS, OURS)).toEqual({ action: 'deactivate' });
  });

  it('no-ops on Delete when a foreign set (or none) is active — never clears an unrelated set', () => {
    expect(decideActivation('Delete', FOREIGN, OURS)).toEqual({ action: 'noop' });
    expect(decideActivation('Delete', undefined, OURS)).toEqual({ action: 'noop' });
  });
});

/**
 * End-to-end test of the ACTUAL deployed inline source (proves deployed == tested):
 * load the generated handler with a mocked `@aws-sdk/client-ses` and drive the
 * custom-resource lifecycle.
 */
interface Sent {
  readonly type: string;
  readonly input: Record<string, unknown>;
}

function loadHandler(activeName: string | undefined): {
  handler: (event: Record<string, unknown>) => Promise<unknown>;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  class DescribeActiveReceiptRuleSetCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class SetActiveReceiptRuleSetCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class SESClient {
    async send(command: { input: Record<string, unknown> }): Promise<unknown> {
      if (command instanceof DescribeActiveReceiptRuleSetCommand) {
        return activeName ? { Metadata: { Name: activeName } } : {};
      }
      if (command instanceof SetActiveReceiptRuleSetCommand) {
        sent.push({ type: 'SetActive', input: command.input });
        return {};
      }
      throw new Error('unexpected command');
    }
  }
  const mockSdk = {
    SESClient,
    DescribeActiveReceiptRuleSetCommand,
    SetActiveReceiptRuleSetCommand,
  };
  const requireShim = (name: string): unknown => {
    if (name === '@aws-sdk/client-ses') {
      return mockSdk;
    }
    throw new Error(`unexpected require: ${name}`);
  };
  const moduleObj: { exports: { handler?: (e: Record<string, unknown>) => Promise<unknown> } } = {
    exports: {},
  };
  // Execute the exact string that ships in the Lambda, against the mocked SDK.
  const factory = new Function('module', 'exports', 'require', buildActivateHandlerSource());
  factory(moduleObj, moduleObj.exports, requireShim);
  return { handler: moduleObj.exports.handler!, sent };
}

describe('buildActivateHandlerSource (deployed inline handler)', () => {
  it('activates ours on Create when nothing is active', async () => {
    const { handler, sent } = loadHandler(undefined);
    await handler({ RequestType: 'Create', ResourceProperties: { RuleSetName: OURS } });
    expect(sent).toEqual([{ type: 'SetActive', input: { RuleSetName: OURS } }]);
  });

  it('throws (aborts the deploy) on Create when a foreign set is active, and calls no Set', async () => {
    const { handler, sent } = loadHandler(FOREIGN);
    await expect(
      handler({ RequestType: 'Create', ResourceProperties: { RuleSetName: OURS } }),
    ).rejects.toThrow(FOREIGN);
    expect(sent).toEqual([]);
  });

  it('deactivates (empty Set) on Delete when ours is active', async () => {
    const { handler, sent } = loadHandler(OURS);
    await handler({
      RequestType: 'Delete',
      PhysicalResourceId: OURS,
      ResourceProperties: { RuleSetName: OURS },
    });
    expect(sent).toEqual([{ type: 'SetActive', input: {} }]);
  });

  it('does nothing on Delete when a foreign set is active', async () => {
    const { handler, sent } = loadHandler(FOREIGN);
    await handler({
      RequestType: 'Delete',
      PhysicalResourceId: OURS,
      ResourceProperties: { RuleSetName: OURS },
    });
    expect(sent).toEqual([]);
  });
});
