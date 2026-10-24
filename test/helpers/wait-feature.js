// A TEST-ONLY FEATURE with one slow tool, `wait`: the protocol tests need a call that takes as long as
// they say — to see progress heartbeats, a long call becoming a task, a cancelled call stopping its
// work — and the server offers no such tool of its own. It is plugged in as any feature is
// (src/features.js), so it goes through the same registry, validation and dispatch as a real tool.

import { currentSignal } from '../../src/request-context.js';

/** The feature; `feature.last` is what the latest call returned (a test reads whether it was cut short). */
export function waitFeature() {
  const feature = {
    id: 'test_wait',
    last: null,
    tools: {
      wait: {
        title: 'Wait',
        description: 'Wait for `seconds`, then return (test only).',
        annotations: { readOnlyHint: true, idempotentHint: true },
        schema: () => ({
          type: 'object', additionalProperties: false, required: ['seconds'],
          properties: { seconds: { type: 'number', minimum: 0, maximum: 30 } },
        }),
        run: async (_engine, input) => {
          const seconds = Number(input.seconds) || 0;
          const started = Date.now();
          const signal = currentSignal();
          let cancelled = false;
          await new Promise((resolve) => {
            const t = setTimeout(resolve, seconds * 1000);
            signal?.addEventListener?.('abort', () => { cancelled = true; clearTimeout(t); resolve(); }, { once: true });
          });
          feature.last = { waited_seconds: cancelled ? Math.round((Date.now() - started) / 100) / 10 : seconds, ...(cancelled ? { cancelled: true } : {}) };
          return feature.last;
        },
      },
    },
  };
  return feature;
}
