import type { Step } from '../pipeline/step.js';
import { analyze } from './analyze.js';
import { approve } from './approve.js';
import { build } from './build.js';
import { clone } from './clone.js';
import { dockerfile } from './dockerfile.js';
import { lint } from './lint.js';
import { smoke } from './smoke.js';

export { analyze, approve, build, clone, dockerfile, lint, smoke };

export const localSteps: Step[] = [clone, analyze, dockerfile, lint, build, smoke, approve];
