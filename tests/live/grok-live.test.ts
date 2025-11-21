import { describe, expect, test } from 'vitest';
import { runOracle, extractTextOutput } from '../../src/oracle.ts';

const ENABLE_LIVE = process.env.ORACLE_LIVE_TEST === '1';
const LIVE_API_KEY = process.env.XAI_API_KEY;

if (!ENABLE_LIVE || !LIVE_API_KEY) {
  describe.skip('Grok live smoke tests', () => {
    test('Set ORACLE_LIVE_TEST=1 with a real XAI_API_KEY to run these integration tests.', () => {});
  });
} else {
  const sharedDeps = {
    apiKey: LIVE_API_KEY,
    log: () => {},
    write: () => true,
  } as const;

  describe('Grok live smoke tests', () => {
    test(
      'grok-4.1 streams a short completion',
      async () => {
        const result = await runOracle(
          {
            prompt: 'Reply with "live grok 4.1 smoke" on one line.',
            model: 'grok-4.1',
            silent: true,
            background: false,
            heartbeatIntervalMs: 0,
            maxOutput: 64,
          },
          sharedDeps,
        );
        if (result.mode !== 'live') {
          throw new Error('Expected live result');
        }
        const text = extractTextOutput(result.response).toLowerCase();
        expect(text).toContain('live grok 4.1 smoke');
        expect(result.response.status ?? 'completed').toBe('completed');
      },
      5 * 60 * 1000,
    );
  });
}
