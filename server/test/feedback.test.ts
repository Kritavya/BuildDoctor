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

import { liftContextScripts } from '../src/steps/plan.js';
describe('liftContextScripts', () => {
  const inv = {
    packages: [
      { dir: '.', scripts: { 'build:types': 'npm run build --prefix packages/types', 'start:server': 'x' } },
      { dir: 'packages/server', scripts: { build: 'tsc', start: 'node .' } },
    ],
  } as never;
  it('rewrites a root-only script to run from the context', () => {
    expect(liftContextScripts(inv, 'npm run build:types && npm run build', 'packages/server', '.'))
      .toBe('npm --prefix ../.. run build:types && npm run build');
  });
  it('leaves the service\'s own scripts and same-dir services alone', () => {
    expect(liftContextScripts(inv, 'npm run start', 'packages/server', '.')).toBe('npm run start');
    expect(liftContextScripts(inv, 'npm run build:types', '.', '.')).toBe('npm run build:types');
  });
});
