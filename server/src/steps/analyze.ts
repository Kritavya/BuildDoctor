// Repository understanding: deterministic detection first, the LLM only fills the gaps.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chatJson } from '../llm/ollama.js';
import type { Step } from '../pipeline/step.js';
import type { AnalysisResult } from '../types.js';
import { isSecretFile, readText, walk } from './common.js';

export interface Detection {
  analysis: AnalysisResult;
  warnings: string[];          // e.g. imported but undeclared dependencies
  gaps: Array<'runtime' | 'entryCommand' | 'port'>;
  sources: Record<string, string>; // which signal each field came from
}

const SOURCE_EXT = /\.(m?js|cjs|ts|py|go)$/;
const DEFAULT_PORTS: Record<string, number> = { express: 3000, next: 3000, fastify: 3000, koa: 3000, nest: 3000, fastapi: 8000, django: 8000, flask: 5000, go: 8080 };
const NODE_BUILTINS = new Set(['fs', 'path', 'http', 'https', 'os', 'url', 'crypto', 'util', 'events', 'stream', 'child_process', 'net', 'zlib', 'assert', 'buffer', 'querystring', 'readline', 'cluster', 'dns', 'tls', 'worker_threads', 'timers', 'process']);

export async function detect(dir: string): Promise<Detection> {
  const files = await walk(dir);
  const has = (f: string) => files.includes(f);
  const read = (f: string) => readText(path.join(dir, f));
  const sources: Record<string, string> = {};
  const warnings: string[] = [];

  const dependencyFiles = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod'].filter(has);
  const code = new Map<string, string>();
  for (const f of files.filter((f) => SOURCE_EXT.test(f) && !/(^|\/)(test|tests|__tests__)\//.test(f)).slice(0, 300)) {
    const t = await read(f);
    if (t !== undefined) code.set(f, t);
  }
  const allCode = [...code.values()].join('\n');

  let runtime: AnalysisResult['runtime'] = 'unknown';
  let framework: string | undefined;
  let entryCommand: string | undefined;
  let port: number | undefined;

  if (has('package.json')) {
    runtime = 'node';
    sources.runtime = 'package.json';
    let pkg: { main?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse((await read('package.json')) ?? '{}');
    } catch {
      warnings.push('package.json is not valid JSON');
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const prodDeps = pkg.dependencies ?? {};
    const fw = (['next', '@nestjs/core', 'fastify', 'koa', 'express'] as const).find((d) => d in deps);
    if (fw) {
      framework = fw === '@nestjs/core' ? 'nest' : fw;
      sources.framework = 'package.json dependencies';
    }
    // Imports that are not declared as production dependencies (the classic "Cannot find module").
    const imported = new Set<string>();
    for (const t of code.values()) {
      for (const m of t.matchAll(/(?:require\(\s*|from\s+|import\s+)['"]([^'"./][^'"]*)['"]/g)) {
        const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
        if (!name.startsWith('node:') && !NODE_BUILTINS.has(name)) imported.add(name);
      }
    }
    for (const name of imported) {
      if (!(name in prodDeps)) warnings.push(`'${name}' is imported but missing from package.json dependencies${name in deps ? ' (only in devDependencies)' : ''}`);
    }
    if (!framework) {
      const fromImports = ['express', 'fastify', 'koa', 'next'].find((d) => imported.has(d));
      if (fromImports) {
        framework = fromImports;
        sources.framework = 'source imports';
      }
    }
    if (pkg.scripts?.start) {
      entryCommand = 'npm start';
      sources.entryCommand = `package.json scripts.start (${pkg.scripts.start})`;
    } else if (pkg.main && has(pkg.main)) {
      entryCommand = `node ${pkg.main}`;
      sources.entryCommand = 'package.json main';
    } else {
      const f = ['server.js', 'index.js', 'app.js', 'main.js', 'src/server.js', 'src/index.js', 'src/app.js'].find(has);
      if (f) {
        entryCommand = `node ${f}`;
        sources.entryCommand = 'common entry file';
      }
    }
  } else if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile') || files.some((f) => f.endsWith('.py'))) {
    runtime = 'python';
    sources.runtime = dependencyFiles.find((f) => f !== 'package.json' && f !== 'go.mod') ?? '.py files';
    const manifest = ((await read('requirements.txt')) ?? '') + ((await read('pyproject.toml')) ?? '') + ((await read('Pipfile')) ?? '');
    const lower = manifest.toLowerCase();
    framework = ['fastapi', 'django', 'flask'].find((d) => new RegExp(`(^|[\\s"'\\[])${d}\\b`, 'm').test(lower));
    if (framework) sources.framework = 'dependency manifest';
    const pyFiles = [...code.keys()].filter((f) => f.endsWith('.py'));
    const appFile = (re: RegExp) => pyFiles.find((f) => re.test(code.get(f)!));
    const mod = (f: string) => f.replace(/\.py$/, '').replace(/\//g, '.');
    if (framework === 'fastapi' || (!framework && /FastAPI\(/.test(allCode))) {
      framework = 'fastapi';
      const f = appFile(/^\s*(\w+)\s*=\s*FastAPI\(/m);
      if (f) {
        const v = code.get(f)!.match(/^\s*(\w+)\s*=\s*FastAPI\(/m)![1];
        entryCommand = `uvicorn ${mod(f)}:${v} --host 0.0.0.0 --port {PORT}`;
        sources.entryCommand = `${f} (${v} = FastAPI())`;
      }
    } else if (framework === 'django' || has('manage.py')) {
      framework = 'django';
      const wsgi = files.find((f) => f.endsWith('/wsgi.py'));
      if (wsgi) {
        entryCommand = `gunicorn ${mod(wsgi)}:application --bind 0.0.0.0:{PORT}`;
        sources.entryCommand = wsgi;
      }
    } else if (framework === 'flask' || /Flask\(__name__/.test(allCode)) {
      framework = 'flask';
      const f = appFile(/^\s*(\w+)\s*=\s*Flask\(/m);
      if (f) {
        const v = code.get(f)!.match(/^\s*(\w+)\s*=\s*Flask\(/m)![1];
        entryCommand = /gunicorn/.test(lower) ? `gunicorn ${mod(f)}:${v} --bind 0.0.0.0:{PORT}` : `python ${f}`;
        sources.entryCommand = f;
      }
    }
    if (!entryCommand) {
      const f = ['main.py', 'app.py', 'server.py'].find(has);
      if (f) {
        entryCommand = `python ${f}`;
        sources.entryCommand = 'common entry file';
      }
    }
  } else if (has('go.mod')) {
    runtime = 'go';
    framework = undefined;
    sources.runtime = 'go.mod';
    entryCommand = './app';
    sources.entryCommand = 'go build output';
  }

  // Port: explicit literals in source beat framework defaults.
  const portPatterns = [
    /\.listen\(\s*(\d{2,5})/,
    /PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/,
    /(?:environ\.get|getenv)\(\s*['"]PORT['"]\s*,\s*['"]?(\d{2,5})/,
    /\bport\s*=\s*(\d{2,5})\b/i,
    /--port[= ](\d{2,5})/,
    /\bPORT\s*[:=]\s*['"]?(\d{2,5})/,
    /":(\d{4,5})"/,
  ];
  for (const [f, t] of code) {
    for (const re of portPatterns) {
      const m = t.match(re);
      if (m) {
        port = Number(m[1]);
        sources.port = `${f}: ${m[0].trim()}`;
        break;
      }
    }
    if (port) break;
  }
  if (!port && framework && DEFAULT_PORTS[framework]) {
    port = DEFAULT_PORTS[framework];
    sources.port = `${framework} default`;
  } else if (!port && runtime === 'go') {
    port = DEFAULT_PORTS.go;
    sources.port = 'go default';
  }
  if (entryCommand && port) entryCommand = entryCommand.replace('{PORT}', String(port));

  // Env var names only; values are never read.
  const envVars = new Set<string>();
  const envPatterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  ];
  for (const t of code.values()) for (const re of envPatterns) for (const m of t.matchAll(re)) envVars.add(m[1]);
  const envExample = files.find((f) => /^\.env\.(example|sample|template)$/.test(f));
  if (envExample) {
    for (const line of ((await read(envExample)) ?? '').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
      if (m) envVars.add(m[1]);
    }
  }

  const analysis: AnalysisResult = {
    runtime,
    framework,
    entryCommand,
    port,
    envVars: [...envVars].sort(),
    dependencyFiles,
    dockerfile: existsSync(path.join(dir, 'Dockerfile')) ? 'present' : 'missing',
  };
  const gaps: Detection['gaps'] = [];
  if (runtime === 'unknown') gaps.push('runtime');
  if (!entryCommand) gaps.push('entryCommand');
  if (!port) gaps.push('port');
  return { analysis, warnings, gaps, sources };
}

// Asks the model for the missing fields. Only file names and dependency manifests are sent.
async function fillGaps(dir: string, det: Detection, signal: AbortSignal): Promise<Partial<AnalysisResult>> {
  const files = (await walk(dir, 200)).filter((f) => !isSecretFile(f));
  const manifests: string[] = [];
  for (const f of det.analysis.dependencyFiles) manifests.push(`--- ${f}\n${((await readText(path.join(dir, f))) ?? '').slice(0, 3000)}`);
  const res = await chatJson<{ runtime?: string; framework?: string; entryCommand?: string; port?: number | string }>(
    [
      {
        role: 'system',
        content:
          'You identify how to run a web application in a container. Reply with JSON only: ' +
          '{"runtime": "node"|"python"|"go"|"unknown", "framework": string|null, "entryCommand": shell command that starts the server, "port": number}.',
      },
      {
        role: 'user',
        content: `Already detected: ${JSON.stringify(det.analysis)}\nMissing: ${det.gaps.join(', ')}\n\nFiles:\n${files.join('\n')}\n\n${manifests.join('\n\n')}`,
      },
    ],
    { signal },
  );
  const out: Partial<AnalysisResult> = {};
  if (det.gaps.includes('runtime') && ['node', 'python', 'go'].includes(res.runtime ?? '')) out.runtime = res.runtime as AnalysisResult['runtime'];
  if (det.gaps.includes('entryCommand') && typeof res.entryCommand === 'string' && res.entryCommand.trim()) out.entryCommand = res.entryCommand.trim();
  const p = Number(res.port);
  if (det.gaps.includes('port') && Number.isInteger(p) && p > 0 && p < 65536) out.port = p;
  if (!det.analysis.framework && typeof res.framework === 'string' && res.framework) out.framework = res.framework.toLowerCase();
  return out;
}

export const analyze: Step = {
  id: 'analyze',
  async run(ctx) {
    const det = await detect(ctx.workdir);
    for (const [k, v] of Object.entries(det.sources)) ctx.log(`${k}: ${v}`);
    for (const w of det.warnings) ctx.log(`warning: ${w}`);
    let analysis = det.analysis;
    if (det.gaps.length) {
      ctx.log(`asking the model to fill: ${det.gaps.join(', ')}`);
      try {
        const filled = await fillGaps(ctx.workdir, det, ctx.signal);
        analysis = { ...analysis, ...filled };
        for (const k of Object.keys(filled)) det.sources[k] = 'LLM';
      } catch (err) {
        ctx.log(`model unavailable (${err instanceof Error ? err.message : err}); continuing with detected values`);
      }
    }
    if (ctx.run.config.appPort) {
      analysis.port = ctx.run.config.appPort;
      det.sources.port = 'user override';
    }
    analysis.envVars = [...new Set([...analysis.envVars, ...Object.keys(ctx.run.config.env ?? {})])].sort();
    ctx.run.analysis = analysis;

    const missingEnv = analysis.envVars.filter((v) => v !== 'PORT' && v !== 'NODE_ENV' && !(ctx.run.config.env ?? {})[v]);
    if (missingEnv.length) ctx.log(`env vars referenced but not provided: ${missingEnv.join(', ')}`);
    if (analysis.runtime === 'unknown') {
      return {
        ok: false,
        summary: 'Could not identify the application runtime',
        error: 'No package.json, requirements.txt, pyproject.toml or go.mod found',
        diagnosis: {
          rootCause: 'Unsupported or unrecognised project layout',
          evidence: `Top-level files: ${(await walk(ctx.workdir, 30)).join(', ')}`,
          attemptedFix: 'none',
          result: 'not-fixed',
          nextStep: 'BuildDoctor supports Node.js, Python and Go services; add a Dockerfile or a dependency manifest.',
        },
      };
    }
    if (!analysis.port) {
      return {
        ok: false,
        summary: 'Could not determine the application port',
        error: 'No port found in source and no framework default',
        diagnosis: { rootCause: 'Unknown application port', evidence: 'No listen()/port pattern found', attemptedFix: 'none', result: 'not-fixed', nextStep: 'Set the application port in the run config.' },
      };
    }
    const label = [analysis.framework ?? analysis.runtime, analysis.port && `:${analysis.port}`].filter(Boolean).join(' ');
    return {
      ok: true,
      summary: `${label} · Dockerfile ${analysis.dockerfile}`,
      output: { ...analysis, warnings: det.warnings, sources: det.sources, missingEnv },
    };
  },
};
