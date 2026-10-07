// Scripted demo run used with ?mock=1. Replays a realistic pipeline, including a
// failed build that the doctor loop fixes, the approval pause and a healthy deploy.
//
// URL options:
//   ?mock=1                 demo backend; press Deploy to start
//   &step=N                 auto-start and apply the first N events instantly, then hold
//   &step=retry|approval|live   named checkpoints (mid-build after a retry, approval prompt, finished)
//   &play=1                 with step: keep playing after the fast-forward
//   &speed=2                playback speed multiplier
//   &scenario=monorepo      two services (web + api) with a retry on the api build and two live URLs
import type { Backend, LocalHealth } from './api'
import type { ApprovalService, DeployOutputs, Diagnosis, NodeId, NodeStatus, RunConfig, RunEvent, RunState } from './contract'

type Entry = { d: number; ev: RunEvent | Omit<Extract<RunEvent, { type: 'log' }>, 'ts'> }

const DOCKERFILE_V1 = `FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
`

const DOCKERFILE_V2 = `FROM node:20-alpine
WORKDIR /app

# Install production dependencies only (no build step: plain Express API)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
`

const BUILD_DIAGNOSIS: Diagnosis = {
  rootCause:
    'The Dockerfile runs "npm run build", but package.json has no build script. This is a plain Express API with nothing to compile.',
  evidence: 'Step 6/9 RUN npm run build  ->  npm ERR! Missing script: "build" (exit code 1)',
  attemptedFix:
    'Removed the build step, installed production dependencies only (npm ci --omit=dev) and copied just src/ into the image.',
  result: 'fixed',
  nextStep: 'Re-lint and rebuild with the corrected Dockerfile.',
}

// Strings below mirror server/src/steps/*.ts and server/src/aws/*.ts so the demo reads like a real run.
export const MOCK_IP = '13.233.41.20'
export const MOCK_INSTANCE = 'i-0f3b2c9e71a4d8c55'
export const MOCK_SG = 'sg-0a91c4e27b3d55f10'
export const DASHBOARD_PORTS = { metrics: 18080, logs: 18081 } as const
const CALLER_CIDR = '49.36.112.7/32'

/** Same slug rule as the server's repoSlug(). */
export function repoSlug(repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? 'app'
  const s = last.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  return (s || 'app').slice(0, 200)
}

function script(cfg: RunConfig, runId: string): Entry[] {
  const repo = cfg.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || 'acme/notes-api'
  const ecrRepo = `builddoctor/${repoSlug(cfg.repoUrl)}`
  const localTag = `builddoctor/${runId}:latest`
  const branch = cfg.branch || 'main'
  const port = cfg.appPort || 3000
  const region = cfg.aws.region
  const size = cfg.aws.instanceType
  const ports = Array.from(new Set([port, ...cfg.aws.openPorts])).filter((p) => p !== 22)
  const envCount = Object.keys(cfg.env ?? {}).length
  const ip = MOCK_IP
  const appUrl = `http://${ip}:${port}/`
  const repoUri = `172083944099.dkr.ecr.${region}.amazonaws.com/${ecrRepo}`

  const out: Entry[] = []
  const node = (d: number, n: NodeId, status: NodeStatus, summary?: string, attempt?: number) =>
    out.push({ d, ev: { type: 'node', node: n, status, summary, attempt } })
  const log = (d: number, n: NodeId, line: string) => out.push({ d, ev: { type: 'log', node: n, line } })
  const output = (d: number, n: NodeId, data: unknown) => out.push({ d, ev: { type: 'output', node: n, data } })

  node(200, 'clone', 'running', `Cloning ${repo}`)
  log(150, 'clone', `$ git clone --depth 1 --branch ${branch} https://github.com/${repo}.git`)
  log(500, 'clone', 'Receiving objects: 100% (142/142), 88.4 KiB | 1.2 MiB/s, done.')
  log(200, 'clone', 'HEAD is now at 3f2c1a9 Add notes search endpoint')
  node(200, 'clone', 'success', `Cloned ${branch} @ 3f2c1a9`)

  node(250, 'analyze', 'running', 'Reading package.json and source')
  log(300, 'analyze', 'Found package.json, package-lock.json')
  log(300, 'analyze', 'Runtime: node 20 (engines field)')
  log(250, 'analyze', 'Framework: express 4.19, entry src/server.js')
  log(250, 'analyze', `Port ${port} from app.listen(process.env.PORT || ${port})`)
  log(200, 'analyze', 'Env vars referenced: DATABASE_URL, JWT_SECRET')
  log(200, 'analyze', 'WARN No Dockerfile in repository')
  output(100, 'analyze', {
    runtime: 'node',
    framework: 'express',
    entryCommand: 'node src/server.js',
    port,
    envVars: ['DATABASE_URL', 'JWT_SECRET'],
    dependencyFiles: ['package.json', 'package-lock.json'],
    dockerfile: 'missing',
  })
  node(150, 'analyze', 'success', `express :${port} · Dockerfile missing`)

  node(250, 'dockerfile', 'running', 'Local model drafting a Dockerfile', 1)
  log(400, 'dockerfile', 'Prompting qwen2.5-coder:7b with project facts (secret values withheld)')
  log(1100, 'dockerfile', 'Draft received: 12 lines, base image node:20-alpine')
  output(100, 'dockerfile', DOCKERFILE_V1)
  node(150, 'dockerfile', 'success', 'Dockerfile generated (model)', 1)

  node(250, 'lint', 'running', 'hadolint', 1)
  log(500, 'lint', 'hadolint: no findings')
  node(150, 'lint', 'success', 'Lint passed · clean', 1)

  node(250, 'build', 'running', `docker build -t ${localTag}`, 1)
  log(250, 'build', '#1 [internal] load build definition from Dockerfile')
  log(300, 'build', '#2 [1/6] FROM docker.io/library/node:20-alpine')
  log(400, 'build', '#5 [3/6] COPY package.json package-lock.json ./')
  log(700, 'build', '#6 [4/6] RUN npm ci   added 87 packages in 6s')
  log(300, 'build', '#7 [5/6] COPY . .')
  log(300, 'build', '#8 [6/6] RUN npm run build')
  log(250, 'build', 'ERROR npm ERR! Missing script: "build"')
  log(100, 'build', 'ERROR process "/bin/sh -c npm run build" did not complete successfully: exit code 1')
  node(200, 'build', 'failed', 'Build failed: npm ERR! Missing script: "build"', 1)

  log(500, 'build', 'Doctor: reading the failing step and package.json scripts')
  out.push({ d: 900, ev: { type: 'retry', from: 'build', to: 'dockerfile', attempt: 2, diagnosis: BUILD_DIAGNOSIS } })

  node(300, 'dockerfile', 'running', 'Applying the fix', 2)
  log(900, 'dockerfile', 'Removed "RUN npm run build"; switched to npm ci --omit=dev')
  output(100, 'dockerfile', DOCKERFILE_V2)
  node(150, 'dockerfile', 'success', 'Dockerfile rewritten (fix attempt 2)', 2)

  node(200, 'lint', 'running', 'hadolint', 2)
  log(400, 'lint', 'hadolint: no findings')
  node(100, 'lint', 'success', 'Lint passed · clean', 2)

  node(200, 'build', 'running', `docker build -t ${localTag}`, 2)
  log(300, 'build', '#2 [1/5] FROM docker.io/library/node:20-alpine (cached)')
  log(600, 'build', '#6 [3/5] RUN npm ci --omit=dev && npm cache clean --force')
  log(500, 'build', '#7 [4/5] COPY src ./src')
  log(300, 'build', `#9 naming to docker.io/${localTag} done`)
  node(150, 'build', 'success', `Built ${localTag} · 142 MB · 38s`, 2)

  node(250, 'smoke', 'running', `Starting container on :${port}`)
  log(400, 'smoke', `$ docker run -d -p ${port}:${port} --env-file <masked> ${localTag}`)
  log(700, 'smoke', `[app] Server listening on ${port}`)
  log(300, 'smoke', `ok GET http://localhost:${port}/  ->  HTTP 200`)
  node(150, 'smoke', 'success', `Container up · port ${port} answered HTTP 200`)

  // plannedActions() in server/src/aws/steps.ts
  const actions = [
    `Create ECR repository ${ecrRepo} in ${region} if missing, and push the image`,
    cfg.aws.existingSecurityGroupId
      ? `Use security group ${cfg.aws.existingSecurityGroupId} (add inbound tcp/${port} from 0.0.0.0/0 if missing)`
      : `Create security group with inbound ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0 (no SSH)`,
    cfg.aws.existingInstanceId
      ? `Deploy to existing instance ${cfg.aws.existingInstanceId} via SSM`
      : `Create EC2 instance ${size} (Amazon Linux 2023 arm64, 16 GB gp3) in ${region}; create IAM role BuildDoctorEC2Role if missing`,
  ]
  if (envCount) actions.push('Store env vars as SSM SecureString parameters')
  actions.push(`Run container 'app' on port ${port}`)

  node(250, 'approve', 'waiting', 'Waiting for your approval')
  log(100, 'approve', 'Pipeline paused: review the AWS changes')
  out.push({ d: 100, ev: { type: 'approval', request: { actions } } })
  // --- the mock pauses here until approve() is called ---
  node(100, 'approve', 'success', 'Approved')

  node(200, 'ecr', 'running', 'Pushing image')
  log(300, 'ecr', `Created ECR repository ${ecrRepo}`)
  log(300, 'ecr', `Tagged ${localTag} as ${repoUri}:${runId}; pushing...`)
  log(800, 'ecr', '5 layers pushed')
  node(150, 'ecr', 'success', `Pushed ${ecrRepo.split('/').pop()}:${runId}`)

  node(200, 'securityGroup', 'running', `Creating builddoctor-${runId}`)
  log(500, 'securityGroup', `Created security group ${MOCK_SG} in vpc-07c1d2e3f4a5b6c7d`)
  if (cfg.aws.openPorts.includes(22)) log(50, 'securityGroup', 'Skipping port 22: SSH is not opened, the instance is managed via SSM')
  log(100, 'securityGroup', `Inbound open: ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0`)
  node(100, 'securityGroup', 'success', `Created ${MOCK_SG}`)

  node(200, 'ec2', 'running', `Launching ${size}`)
  log(300, 'ec2', 'Reusing IAM role BuildDoctorEC2Role')
  log(300, 'ec2', 'AMI ami-0d1e2f3a4b5c6d7e8 (Amazon Linux 2023 arm64)')
  log(400, 'ec2', `Launched ${MOCK_INSTANCE} (${size})`)
  log(1200, 'ec2', `Instance running at ${ip}`)
  log(300, 'ec2', 'Waiting for the SSM agent to come online...')
  log(900, 'ec2', 'SSM agent online')
  node(150, 'ec2', 'success', `${MOCK_INSTANCE} @ ${ip}`)

  node(200, 'deploy', 'running', 'Starting container on the instance')
  if (envCount) log(300, 'deploy', `Stored ${envCount} env var(s) as SSM SecureStrings: ${Object.keys(cfg.env ?? {}).join(', ')}`)
  log(400, 'deploy', `Deploying ${ecrRepo.split('/').pop()}:${runId} to ${MOCK_INSTANCE} on port ${port}`)
  log(800, 'deploy', 'Login Succeeded')
  node(150, 'deploy', 'success', `Container 'app' started on :${port}`)

  node(200, 'health', 'running', `Checking ${appUrl}`)
  log(300, 'health', `Checking ${appUrl}`)
  log(900, 'health', 'Healthy: HTTP 200')
  node(150, 'health', 'success', 'Live: HTTP 200')

  node(150, 'dashboard', 'running')
  log(100, 'dashboard', `Monitoring dashboard (cAdvisor metrics :${DASHBOARD_PORTS.metrics}, Dozzle logs :${DASHBOARD_PORTS.logs}) is available but off.`)
  log(50, 'dashboard', 'Enabling it opens those ports to your current public IP only.')
  output(0, 'dashboard', { enabled: false, available: true, ports: DASHBOARD_PORTS })
  node(100, 'dashboard', 'success', 'Dashboard available (off)')
  out.push({ d: 200, ev: { type: 'done', status: 'live', appUrl } })
  return out
}

// ---------- monorepo scenario (&scenario=monorepo): web + api, one api retry, two URLs live ----------

const WEB_DOCKERFILE = `FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM node:20-slim
WORKDIR /app
COPY --from=build /app /app
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["npm", "run", "start", "-w", "apps/web"]
`

const API_V1 = `FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api
COPY apps/api apps/api
ENV PORT=4000 HOST=0.0.0.0
EXPOSE 4000
USER node
CMD ["node", "apps/api/src/server.js"]
`

const API_V2 = `FROM node:20-slim
WORKDIR /app
# The API imports the workspace package @shop/db: copy its manifest so npm links it locally
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
RUN npm ci -w apps/api -w packages/db --omit=dev
COPY packages/db packages/db
COPY apps/api apps/api
ENV PORT=4000 HOST=0.0.0.0
EXPOSE 4000
USER node
CMD ["node", "apps/api/src/server.js"]
`

const API_DIAGNOSIS: Diagnosis = {
  rootCause: 'api: npm tried to download @shop/db from the public registry. It is a workspace package, but the Dockerfile never copied packages/db into the image.',
  evidence: "[api] npm ERR! 404 Not Found - GET https://registry.npmjs.org/@shop%2fdb - '@shop/db@*' is not in this registry.",
  attemptedFix: "Copy packages/db/package.json before npm ci and install with -w packages/db, so npm links the workspace package instead of fetching it.",
  result: 'fixed',
  nextStep: 'Re-lint and rebuild the api image; web is unchanged and keeps its image.',
}

const MONO_SERVICES = [
  { name: 'web', root: 'apps/web', context: '.', dockerfile: 'apps/web/Dockerfile', existingDockerfile: false, kind: 'server' as const, runtime: 'node', framework: 'next', installCommand: 'npm ci -w apps/web', buildCommand: 'npm run build -w apps/web', startCommand: 'npm run start -w apps/web', port: 3000, portEvidence: 'apps/web/package.json: "start": "next start -p 3000"', envVars: ['API_URL'], dependsOn: ['api'] },
  { name: 'api', root: 'apps/api', context: '.', dockerfile: 'apps/api/Dockerfile', existingDockerfile: false, kind: 'server' as const, runtime: 'node', framework: 'express', installCommand: 'npm ci -w apps/api', startCommand: 'node apps/api/src/server.js', port: 4000, portEvidence: 'apps/api/src/server.js:41 app.listen(process.env.PORT || 4000)', envVars: ['DATABASE_URL', 'SENTRY_DSN'], dependsOn: [] },
]

function monorepoScript(cfg: RunConfig, runId: string): Entry[] {
  const repo = cfg.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || 'acme/shop-monorepo'
  const ecrRepo = `builddoctor/${repoSlug(cfg.repoUrl)}`
  const branch = cfg.branch || 'main'
  const region = cfg.aws.region
  const size = cfg.aws.instanceType
  const ip = MOCK_IP
  const repoUri = `172083944099.dkr.ecr.${region}.amazonaws.com/${ecrRepo}`
  const net = `builddoctor-${runId}`
  const svcPorts = MONO_SERVICES.map((s) => s.port)
  const ports = Array.from(new Set([...svcPorts, ...cfg.aws.openPorts])).filter((p) => p !== 22)
  const tag = (name: string) => (name === 'web' ? runId : `${runId}-${name}`)
  const local = (name: string) => (name === 'web' ? `builddoctor/${runId}:latest` : `builddoctor/${runId}-${name}:latest`)
  const url = (port: number) => `http://${ip}:${port}/`
  const provided = (svc: string) => new Set([...Object.keys(cfg.env ?? {}), ...Object.keys(cfg.serviceEnv?.[svc] ?? {})])

  const out: Entry[] = []
  const node = (d: number, n: NodeId, status: NodeStatus, summary?: string, attempt?: number) =>
    out.push({ d, ev: { type: 'node', node: n, status, summary, attempt } })
  const log = (d: number, n: NodeId, line: string) => out.push({ d, ev: { type: 'log', node: n, line } })
  const output = (d: number, n: NodeId, data: unknown) => out.push({ d, ev: { type: 'output', node: n, data } })
  const svc = (d: number, n: NodeId, service: string, status: NodeStatus, summary?: string) =>
    out.push({ d, ev: { type: 'service', node: n, service, status, summary } })

  node(200, 'clone', 'running', `Cloning ${repo}`)
  log(150, 'clone', `$ git clone --depth 1 --branch ${branch} https://github.com/${repo}.git`)
  log(500, 'clone', 'Receiving objects: 100% (388/388), 214.7 KiB | 1.6 MiB/s, done.')
  log(200, 'clone', 'HEAD is now at 9b41e07 Checkout: show order totals')
  node(200, 'clone', 'success', `Cloned ${branch} @ 9b41e07`)

  node(250, 'analyze', 'running', 'Building the repo inventory')
  log(300, 'analyze', 'npm workspaces: apps/*, packages/*')
  log(300, 'analyze', 'Asking the local model for a service plan (attempt 1 of 4)')
  for (const s of MONO_SERVICES) {
    log(250, 'analyze', `service ${s.name}: ${s.kind} at ${s.root} (context .) · port ${s.port} [${s.portEvidence}] · generate ${s.dockerfile}`)
  }
  log(150, 'analyze', 'skipped packages/db: library used by api, starts no server')
  log(150, 'analyze', 'skipped packages/ui: library used by web, starts no server')
  output(100, 'analyze', {
    runtime: 'node', framework: 'next', entryCommand: MONO_SERVICES[0].startCommand, port: 3000,
    envVars: ['API_URL', 'DATABASE_URL', 'SENTRY_DSN'], dependencyFiles: ['apps/web/package.json', 'apps/api/package.json'],
    dockerfile: 'missing', services: MONO_SERVICES,
  })
  node(150, 'analyze', 'success', '2 services: web:3000, api:4000 · Dockerfile 0 existing')

  node(250, 'dockerfile', 'running', 'Local model drafting 2 Dockerfiles', 1)
  svc(50, 'dockerfile', 'web', 'running')
  log(500, 'dockerfile', '[web] no Dockerfile — generating apps/web/Dockerfile')
  log(900, 'dockerfile', '[web] draft accepted: 2 stages, node:20-slim')
  svc(50, 'dockerfile', 'web', 'success', 'generated')
  svc(50, 'dockerfile', 'api', 'running')
  log(500, 'dockerfile', '[api] no Dockerfile — generating apps/api/Dockerfile')
  log(800, 'dockerfile', '[api] draft accepted: node:20-slim')
  svc(50, 'dockerfile', 'api', 'success', 'generated')
  output(100, 'dockerfile', {
    mode: 'generated', source: 'llm', path: 'apps/web/Dockerfile', dockerfile: WEB_DOCKERFILE,
    services: { web: { mode: 'generated', source: 'llm', path: 'apps/web/Dockerfile', dockerfile: WEB_DOCKERFILE }, api: { mode: 'generated', source: 'llm', path: 'apps/api/Dockerfile', dockerfile: API_V1 } },
  })
  node(150, 'dockerfile', 'success', '2 Dockerfiles · web: generated, api: generated', 1)

  node(250, 'lint', 'running', 'hadolint', 1)
  for (const s of ['web', 'api']) {
    svc(50, 'lint', s, 'running')
    log(350, 'lint', `[${s}] hadolint: no findings`)
    svc(50, 'lint', s, 'success', '0 warning(s)')
  }
  output(50, 'lint', { findings: [], services: { web: [], api: [] } })
  node(150, 'lint', 'success', 'Lint passed · clean', 1)

  node(250, 'build', 'running', 'docker build · 2 images', 1)
  svc(50, 'build', 'web', 'running')
  log(250, 'build', '[web] #1 [internal] load build definition from Dockerfile')
  log(400, 'build', '[web] #7 [build 5/6] RUN npm ci -w apps/web   added 312 packages in 14s')
  log(600, 'build', '[web] #9 [build 6/6] RUN npm run build -w apps/web   Compiled successfully')
  log(300, 'build', `[web] #12 naming to docker.io/${local('web')} done`)
  svc(50, 'build', 'web', 'success', '188 MB · 41s')
  svc(50, 'build', 'api', 'running')
  log(300, 'build', '[api] #1 [internal] load build definition from Dockerfile')
  log(500, 'build', '[api] #6 [4/6] RUN npm ci -w apps/api')
  log(300, 'build', "[api] npm ERR! 404 Not Found - GET https://registry.npmjs.org/@shop%2fdb - '@shop/db@*' is not in this registry.")
  log(100, 'build', '[api] ERROR: process "/bin/sh -c npm ci -w apps/api" did not complete successfully: exit code 1')
  svc(50, 'build', 'api', 'failed', 'npm ERR! 404 @shop/db is not in this registry')
  node(200, 'build', 'failed', '[api] Build failed: npm ERR! 404 @shop/db is not in this registry', 1)
  log(400, 'build', 'diagnosing build failure...')
  out.push({ d: 900, ev: { type: 'retry', from: 'build', to: 'dockerfile', attempt: 2, diagnosis: API_DIAGNOSIS, service: 'api' } })

  node(300, 'dockerfile', 'running', 'Fixing the api Dockerfile', 2)
  svc(50, 'dockerfile', 'api', 'running', 'fixing (attempt 2)')
  log(300, 'dockerfile', '[api] doctor loop attempt 2: build failed — npm tried to download @shop/db from the public registry')
  log(900, 'dockerfile', '[api] copy packages/db and install it as a workspace')
  svc(50, 'dockerfile', 'api', 'success', 'rewritten (fix attempt 2)')
  output(100, 'dockerfile', { mode: 'fixed', service: 'api', path: 'apps/api/Dockerfile', dockerfile: API_V2, previous: API_V1, fixing: API_DIAGNOSIS, services: { web: { mode: 'generated' }, api: { mode: 'fixed' } } })
  node(150, 'dockerfile', 'success', 'api: Dockerfile rewritten (fix attempt 2)', 2)

  node(200, 'lint', 'running', 'hadolint', 2)
  svc(50, 'lint', 'api', 'running')
  log(400, 'lint', '[api] hadolint: no findings')
  svc(50, 'lint', 'api', 'success', '0 warning(s)')
  output(50, 'lint', { findings: [], services: { api: [] } })
  node(100, 'lint', 'success', 'Lint passed · clean', 2)

  node(200, 'build', 'running', 'docker build · api', 2)
  svc(50, 'build', 'api', 'running')
  log(300, 'build', '[api] #6 [4/8] COPY packages/db/package.json packages/db/')
  log(600, 'build', '[api] #7 [5/8] RUN npm ci -w apps/api -w packages/db --omit=dev   added 64 packages in 5s')
  log(300, 'build', `[api] #10 naming to docker.io/${local('api')} done`)
  svc(50, 'build', 'api', 'success', '96 MB · 22s')
  output(50, 'build', {
    image: local('web'), sizeMb: 188, arch: 'arm64',
    services: { web: { image: local('web'), sizeMb: 188, arch: 'arm64', layers: 11 }, api: { image: local('api'), sizeMb: 96, arch: 'arm64', layers: 9 } },
  })
  node(150, 'build', 'success', 'Built 2 images · web 188 MB · 41s, api 96 MB · 22s', 2)

  node(250, 'smoke', 'running', 'Starting 2 containers')
  for (const s of [...MONO_SERVICES].reverse()) {
    svc(50, 'smoke', s.name, 'running')
    log(400, 'smoke', `docker run -p 5${s.port}:${s.port} ${local(s.name)} (env: ${[...provided(s.name)].join(', ')})`)
    log(600, 'smoke', `[${s.name}] [app] ${s.name === 'api' ? `api listening on 0.0.0.0:${s.port}` : `▲ Next.js 14.2.5 - Local: http://0.0.0.0:${s.port}`}`)
    svc(50, 'smoke', s.name, 'success', `port ${s.port} answered HTTP 200`)
  }
  output(50, 'smoke', {
    port: 3000, check: 'http', status: 200,
    services: {
      web: { port: 3000, check: 'http', status: 200, logs: '▲ Next.js 14.2.5\n- Local: http://0.0.0.0:3000\n✓ Ready in 412ms' },
      api: { port: 4000, check: 'http', status: 200, logs: 'api listening on 0.0.0.0:4000\nGET / 200 3ms' },
    },
  })
  node(150, 'smoke', 'success', '2 containers up · web :3000, api :4000')

  // approvalPlan() in server/src/aws/steps.ts
  const services: ApprovalService[] = MONO_SERVICES.map((s) => {
    const have = provided(s.name)
    const injected: Record<string, string> = s.name === 'web' && !have.has('API_URL') ? { API_URL: 'http://app-api:4000' } : {}
    return {
      name: s.name, container: `app-${s.name}`, image: `${ecrRepo}:${tag(s.name)}`, port: s.port, kind: s.kind, injected,
      unset: s.envVars.filter((n) => !have.has(n) && !(n in injected)).sort(), notes: [],
    }
  })
  const actions = [
    `Create ECR repository ${ecrRepo} in ${region} if missing, and push 2 images (one per service)`,
    cfg.aws.existingSecurityGroupId
      ? `Use security group ${cfg.aws.existingSecurityGroupId} (add inbound ${svcPorts.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0 if missing)`
      : `Create security group with inbound ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0 (no SSH)`,
    cfg.aws.existingInstanceId
      ? `Deploy to existing instance ${cfg.aws.existingInstanceId} via SSM`
      : `Create EC2 instance ${size} (Amazon Linux 2023 arm64, 16 GB gp3) in ${region}; create IAM role BuildDoctorEC2Role if missing`,
    'Store env vars as SSM SecureString parameters',
    `Create Docker network ${net} on the instance so the 2 services reach each other by container name`,
    ...services.map((s) => `Run container '${s.container}' (${s.name}, image ${s.image}) on port ${s.port}${Object.keys(s.injected).length ? `, with ${Object.entries(s.injected).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`),
    ...services.filter((s) => s.unset.length).map((s) => `Env vars ${s.name} reads that were not provided: ${s.unset.join(', ')} (you may need to set ${s.unset.length > 1 ? 'them' : 'it'})`),
    'If the health check finds the app listening on a different port, add an inbound rule for that port from 0.0.0.0/0 to the new security group and redeploy',
  ]
  node(250, 'approve', 'waiting', 'Waiting for your approval')
  log(100, 'approve', 'Pipeline paused: review the AWS changes')
  out.push({ d: 100, ev: { type: 'approval', request: { actions, services } } })
  node(100, 'approve', 'success', 'Approved')

  node(200, 'ecr', 'running', 'Pushing 2 images')
  log(300, 'ecr', `Created ECR repository ${ecrRepo}`)
  for (const s of MONO_SERVICES) {
    log(300, 'ecr', `[${s.name}] Tagged ${local(s.name)} as ${repoUri}:${tag(s.name)}; pushing...`)
    log(700, 'ecr', `[${s.name}] ${s.name === 'web' ? 7 : 5} layers pushed`)
  }
  node(150, 'ecr', 'success', 'Pushed 2 images · web, api')

  node(200, 'securityGroup', 'running', `Creating builddoctor-${runId}`)
  log(500, 'securityGroup', `Created security group ${MOCK_SG} in vpc-07c1d2e3f4a5b6c7d`)
  log(100, 'securityGroup', `Inbound open: ${ports.map((p) => `tcp/${p}`).join(', ')} from 0.0.0.0/0`)
  node(100, 'securityGroup', 'success', `Created ${MOCK_SG}`)

  node(200, 'ec2', 'running', `Launching ${size}`)
  log(300, 'ec2', 'Reusing IAM role BuildDoctorEC2Role')
  log(400, 'ec2', `Launched ${MOCK_INSTANCE} (${size})`)
  log(1200, 'ec2', `Instance running at ${ip}`)
  log(900, 'ec2', 'SSM agent online')
  node(150, 'ec2', 'success', `${MOCK_INSTANCE} @ ${ip}`)

  node(200, 'deploy', 'running', 'Starting 2 containers on the instance')
  log(300, 'deploy', `Stored ${Object.keys(cfg.env ?? {}).length + Object.keys(cfg.serviceEnv?.api ?? {}).length} env var(s) as SSM SecureStrings: ${[...Object.keys(cfg.env ?? {}), ...Object.keys(cfg.serviceEnv?.api ?? {}).map((k) => `api/${k}`)].join(', ')}`)
  if (services[0].injected.API_URL) log(100, 'deploy', '[web] API_URL=http://app-api:4000 (address of a service it calls)')
  log(200, 'deploy', `Deploying 2 containers to ${MOCK_INSTANCE} on network ${net}: app-web :3000, app-api :4000`)
  for (const s of MONO_SERVICES) svc(30, 'deploy', s.name, 'running')
  log(600, 'deploy', `Network ${net} ready`)
  log(400, 'deploy', 'app-api: env file written (3 vars)')
  log(400, 'deploy', 'app-web: env file written (2 vars)')
  log(500, 'deploy', 'app-api container: Up 3 seconds')
  log(100, 'deploy', 'app-web container: Up 2 seconds')
  for (const s of MONO_SERVICES) svc(30, 'deploy', s.name, 'success', `app-${s.name} :${s.port}`)
  output(50, 'deploy', {
    instanceId: MOCK_INSTANCE, imageUri: `${repoUri}:${runId}`, port: 3000, network: net,
    services: Object.fromEntries(MONO_SERVICES.map((s) => [s.name, { container: `app-${s.name}`, imageUri: `${repoUri}:${tag(s.name)}`, port: s.port }])),
  })
  node(150, 'deploy', 'success', '2 containers started · web :3000, api :4000')

  node(200, 'health', 'running', 'Checking 2 services')
  for (const s of MONO_SERVICES) {
    log(100, 'health', `[${s.name}] Checking ${url(s.port)}`)
    svc(20, 'health', s.name, 'running')
  }
  log(900, 'health', '[api] Healthy: HTTP 200')
  svc(30, 'health', 'api', 'success', 'HTTP 200')
  log(400, 'health', '[web] Healthy: HTTP 200')
  svc(30, 'health', 'web', 'success', 'HTTP 200')
  const live = Object.fromEntries(MONO_SERVICES.map((s) => [s.name, { url: url(s.port), port: s.port, container: `app-${s.name}`, imageUri: `${repoUri}:${tag(s.name)}`, healthy: true }]))
  output(50, 'health', { appUrl: url(3000), services: Object.fromEntries(MONO_SERVICES.map((s) => [s.name, { url: url(s.port), port: s.port, healthy: true, status: 200 }])) })
  node(150, 'health', 'success', 'Live: 2 services healthy')

  node(150, 'dashboard', 'running')
  log(100, 'dashboard', `Monitoring dashboard (cAdvisor metrics :${DASHBOARD_PORTS.metrics}, Dozzle logs :${DASHBOARD_PORTS.logs}) is available but off.`)
  output(0, 'dashboard', { enabled: false, available: true, ports: DASHBOARD_PORTS })
  node(100, 'dashboard', 'success', 'Dashboard available (off)')
  out.push({ d: 200, ev: { type: 'done', status: 'live', appUrl: url(3000), services: live } })
  return out
}

const DEFAULT_CFG: RunConfig = {
  repoUrl: 'https://github.com/acme/notes-api',
  branch: 'main',
  aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [80] },
}

function resolveStep(step: string, entries: Entry[]): number {
  const at = (pred: (e: Entry) => boolean) => entries.findIndex(pred)
  if (step === 'retry') {
    // a few events after the retry fired: Dockerfile rewritten, lint re-running
    return at((e) => e.ev.type === 'node' && e.ev.node === 'lint' && e.ev.attempt === 2) + 1
  }
  if (step === 'approval') return at((e) => e.ev.type === 'approval') + 1
  if (step === 'live') return entries.length
  const n = Number(step)
  return Number.isFinite(n) ? Math.min(Math.max(0, n), entries.length) : 0
}

export interface MockOptions {
  step?: string
  play: boolean
  speed: number
  /** 'monorepo': web + api, one api retry, two URLs live */
  scenario?: string
}

export function createMockBackend(opts: MockOptions): Backend {
  let cfg: RunConfig = DEFAULT_CFG
  let entries: Entry[] = []
  let idx = 0
  let timer: number | undefined
  let emit: ((ev: RunEvent) => void) | undefined
  let pausedForApproval = false
  let runId = ''
  let dashboardOn = false
  let tornDown = false
  const ip = MOCK_IP
  const mono = opts.scenario === 'monorepo'

  /** Mirrors what the server records in outputs.created as each AWS step succeeds. */
  const created = (): DeployOutputs['created'] => {
    if (tornDown) return []
    const done = new Set(
      entries.slice(0, idx).flatMap((e) => (e.ev.type === 'node' && e.ev.status === 'success' ? [e.ev.node] : [])),
    )
    const list: DeployOutputs['created'] = []
    if (done.has('ecr')) list.push({ type: 'ecr', id: `builddoctor/${repoSlug(cfg.repoUrl)}` })
    if (done.has('securityGroup') && !cfg.aws.existingSecurityGroupId) list.push({ type: 'sg', id: MOCK_SG })
    if (done.has('securityGroup') && cfg.aws.existingSecurityGroupId)
      list.push({ type: 'sg-rule', id: `${cfg.aws.existingSecurityGroupId}:${cfg.appPort || 3000}:0.0.0.0/0` })
    if (done.has('ec2') && !cfg.aws.existingInstanceId) list.push({ type: 'ec2', id: MOCK_INSTANCE })
    if (dashboardOn && cfg.aws.existingSecurityGroupId) {
      for (const p of [DASHBOARD_PORTS.metrics, DASHBOARD_PORTS.logs])
        list.push({ type: 'sg-rule', id: `${cfg.aws.existingSecurityGroupId}:${p}:${CALLER_CIDR}` })
    }
    return list
  }

  const toEvent = (e: Entry): RunEvent =>
    e.ev.type === 'log' ? { ...e.ev, ts: Date.now() } : (e.ev as RunEvent)

  const fire = (): boolean => {
    const e = entries[idx++]
    emit?.(toEvent(e))
    if (e.ev.type === 'approval') {
      pausedForApproval = true
      return false
    }
    return true
  }

  const schedule = () => {
    if (idx >= entries.length || pausedForApproval) return
    timer = window.setTimeout(() => {
      if (fire()) schedule()
    }, entries[idx].d / opts.speed)
  }

  return {
    mock: true,
    health: () =>
      new Promise<LocalHealth>((r) =>
        setTimeout(() => r({ docker: true, ollama: true, model: 'qwen2.5-coder:7b', awsAccount: '1720-8394-4099' }), 700),
      ),
    async start(c) {
      cfg = c
      runId = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
      entries = mono ? monorepoScript(cfg, runId) : script(cfg, runId)
      idx = 0
      pausedForApproval = false
      dashboardOn = false
      tornDown = false
      return runId
    },
    subscribe(_id, onEvent) {
      emit = onEvent
      if (opts.step !== undefined) {
        const n = resolveStep(opts.step, entries)
        while (idx < n) {
          const e = entries[idx]
          // Fast-forwarding past the approval pause counts as an approval.
          if (e.ev.type === 'approval' && n > idx + 1) {
            idx++
            continue
          }
          fire()
        }
        if (opts.play) schedule()
      } else {
        schedule()
      }
      return () => {
        window.clearTimeout(timer)
        emit = undefined
      }
    },
    async approve(_id, approved) {
      if (!pausedForApproval) return
      pausedForApproval = false
      if (approved) {
        schedule()
      } else {
        window.clearTimeout(timer)
        emit?.({ type: 'node', node: 'approve', status: 'failed', summary: 'Cancelled by you' })
        emit?.({ type: 'log', node: 'approve', line: 'Run stopped before any AWS change', ts: Date.now() })
        emit?.({
          type: 'done',
          status: 'failed',
          diagnosis: {
            rootCause: 'You cancelled the run at the approval step.',
            evidence: 'No AWS resources were created.',
            attemptedFix: 'None needed.',
            result: 'not-fixed',
            nextStep: 'Start a new run when you are ready to deploy.',
          },
        })
      }
    },
    async getRun(id) {
      const state = {
        id,
        config: cfg,
        outputs: {
          created: created(),
          instanceId: cfg.aws.existingInstanceId ?? MOCK_INSTANCE,
          securityGroupId: cfg.aws.existingSecurityGroupId ?? MOCK_SG,
          publicIp: ip,
        },
        status: tornDown ? 'torn-down' : 'live',
        createdAt: Date.now(),
      }
      return state as unknown as RunState
    },
    // Like the server's setDashboard(): no pipeline events, just the new dashboard state.
    async dashboard(_id, enabled) {
      await new Promise((r) => setTimeout(r, 600))
      dashboardOn = enabled
      return enabled
        ? { enabled: true, metricsUrl: `http://${ip}:${DASHBOARD_PORTS.metrics}/`, logsUrl: `http://${ip}:${DASHBOARD_PORTS.logs}/` }
        : { enabled: false }
    },
    // Same result lines as server/src/aws/teardown.ts.
    async teardown() {
      await new Promise((r) => setTimeout(r, 900))
      const repo = `builddoctor/${repoSlug(cfg.repoUrl)}`
      const lines: string[] = []
      const c = created()
      if (c.some((x) => x.type === 'ec2')) lines.push(`EC2 instance ${MOCK_INSTANCE} terminated`)
      else if (cfg.aws.existingInstanceId) lines.push(`Kept pre-existing instance ${cfg.aws.existingInstanceId} (${mono ? "the 'app-web', 'app-api' containers keep" : "the 'app' container keeps"} running)`)
      if (c.some((x) => x.type === 'sg')) lines.push(`Security group ${MOCK_SG} deleted`)
      for (const r of c.filter((x) => x.type === 'sg-rule')) {
        const [g, p, cidr] = r.id.split(':')
        lines.push(`Revoked inbound tcp/${p} from ${cidr} on your security group ${g}`)
      }
      if (cfg.aws.existingSecurityGroupId) lines.push(`Kept pre-existing security group ${cfg.aws.existingSecurityGroupId}`)
      if (c.some((x) => x.type === 'ecr')) {
        lines.push(mono
          ? `ECR images ${repo}:${runId}, ${repo}:${runId}-api deleted; empty ECR repository ${repo} deleted`
          : `ECR image ${repo}:${runId} deleted; empty ECR repository ${repo} deleted`)
      }
      const envCount = Object.keys(cfg.env ?? {}).length + Object.values(cfg.serviceEnv ?? {}).reduce((n, e) => n + Object.keys(e).length, 0)
      if (envCount) lines.push(`${envCount} SSM env parameter(s) deleted`)
      if (!cfg.aws.existingInstanceId) lines.push('Kept shared IAM role/instance profile BuildDoctorEC2Role (reused by other runs)')
      tornDown = true
      dashboardOn = false
      return { deleted: lines }
    },
  }
}
