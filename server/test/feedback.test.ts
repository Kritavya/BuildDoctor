import { describe, expect, it } from 'vitest';
import { planFeedback } from '../src/steps/plan.js';
import { dockerfileFeedback } from '../src/steps/dockerfile.js';

describe('retry feedback keeps earlier problems', () => {
  it('plan feedback lists the current problems and every earlier one once', () => {
    const history = [['no start script'], ['shared packages not built first'], ['no start script']];
    const msg = planFeedback(history[2], history);
    expect(msg).toContain('no start script');
    expect(msg).toContain('Earlier attempts were also rejected');
    expect(msg).toContain('shared packages not built first');
    expect(msg.match(/no start script/g)).toHaveLength(1);
  });
  it('first retry has no earlier section', () => {
    expect(planFeedback(['x'], [['x']])).not.toContain('Earlier attempts');
  });
  it('dockerfile feedback carries earlier rejections', () => {
    const msg = dockerfileFeedback(['CMD does not run npm start'], ['missing EXPOSE', 'CMD does not run npm start']);
    expect(msg).toContain('Earlier drafts were also rejected for: missing EXPOSE');
  });
});
