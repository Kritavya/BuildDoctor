import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detect } from '../src/steps/analyze.js';
import { ensureNonRoot, validate, template } from '../src/steps/dockerfile.js';
import { stripFences } from '../src/steps/common.js';

const fx = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);

describe('analyze (deterministic detection)', () => {
  it('express-app', async () => {
    const d = await detect(fx('express-app'));
    expect(d.analysis).toEqual({
      runtime: 'node',
      framework: 'express',
      entryCommand: 'npm start',
      port: 3000,
      envVars: ['GREETING', 'PORT'],
      dependencyFiles: ['package.json'],
      dockerfile: 'missing',
    });
    expect(d.gaps).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('fastapi-app', async () => {
    const d = await detect(fx('fastapi-app'));
    expect(d.analysis).toMatchObject({
      runtime: 'python',
      framework: 'fastapi',
      entryCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000',
      port: 8000,
      envVars: ['APP_NAME'],
      dependencyFiles: ['requirements.txt'],
      dockerfile: 'missing',
    });
    expect(d.gaps).toEqual([]);
  });

  it('express-broken: existing Dockerfile, express imported but undeclared', async () => {
    const d = await detect(fx('express-broken'));
    expect(d.analysis).toMatchObject({ runtime: 'node', framework: 'express', entryCommand: 'node server.js', port: 3000, dockerfile: 'present' });
    expect(d.warnings.join()).toMatch(/'express' is imported but missing/);
  });
});

describe('dockerfile helpers', () => {
  it('strips markdown fences and validates', () => {
    const df = stripFences('Here you go:\n```dockerfile\nFROM node:20-slim\nEXPOSE 3000\nCMD ["node","a.js"]\n```\nDone.');
    expect(df).toBe('FROM node:20-slim\nEXPOSE 3000\nCMD ["node","a.js"]\n');
    expect(validate(df, 3000)).toEqual([]);
    expect(validate('RUN echo hi\n', 3000)).toEqual(['missing FROM instruction', 'missing CMD/ENTRYPOINT', 'does not EXPOSE 3000']);
  });

  it('adds a non-root user before CMD when missing', () => {
    expect(ensureNonRoot('FROM node:20-slim\nCOPY . .\nCMD ["npm","start"]\n')).toBe('FROM node:20-slim\nCOPY . .\nUSER node\nCMD ["npm","start"]\n');
    expect(ensureNonRoot('FROM python:3.12-slim\nCMD ["python","a.py"]\n')).toMatch(/useradd --create-home app\nUSER app\nCMD/);
    expect(ensureNonRoot('FROM node:20-slim\nUSER node\nCMD ["x"]\n')).toBe('FROM node:20-slim\nUSER node\nCMD ["x"]\n');
  });

  it('flags COPY of files that do not exist and npm ci without a lockfile', () => {
    const p = validate('FROM node:20-slim\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nEXPOSE 3000\nCMD ["npm","start"]\n', 3000, ['package.json', 'server.js']);
    expect(p).toEqual(['COPY source "package-lock.json" does not exist in the repository', 'uses "npm ci" but there is no package-lock.json (use "npm install --omit=dev")']);
  });

  it('template produces a valid Dockerfile', () => {
    const t = template({ runtime: 'python', entryCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', port: 8000, envVars: [], dependencyFiles: ['requirements.txt'], dockerfile: 'missing' }, ['requirements.txt', 'main.py']);
    expect(validate(t, 8000)).toEqual([]);
    expect(t).toMatch(/USER app/);
  });
});
