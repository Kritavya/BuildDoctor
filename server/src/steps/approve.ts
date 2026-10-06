// Approval gate. The pause/resume behaviour lives in the engine; this step only confirms.
import type { Step } from '../pipeline/step.js';

export const approve: Step = {
  id: 'approve',
  async run() {
    return { ok: true, summary: 'Approved' };
  },
};
