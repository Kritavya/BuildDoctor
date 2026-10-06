// Scripted demo run used with ?mock=1. Replays a realistic pipeline, including a
// failed build that the doctor loop fixes, the approval pause and a healthy deploy.
//
// URL options:
//   ?mock=1                 demo backend; press Deploy to start
//   &step=N                 auto-start and apply the first N events instantly, then hold
//   &step=retry|approval|live   named checkpoints (mid-build after a retry, approval prompt, finished)
//   &play=1                 with step: keep playing after the fast-forward
//   &speed=2                playback speed multiplier
import type { Backend, LocalHealth } from './api'
import type { DeployOutputs, Diagnosis, NodeId, NodeStatus, RunConfig, RunEvent, RunState } from './contract'

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
      entries = script(cfg, runId)
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
      else if (cfg.aws.existingInstanceId) lines.push(`Kept pre-existing instance ${cfg.aws.existingInstanceId} (the 'app' container keeps running)`)
      if (c.some((x) => x.type === 'sg')) lines.push(`Security group ${MOCK_SG} deleted`)
      for (const r of c.filter((x) => x.type === 'sg-rule')) {
        const [g, p, cidr] = r.id.split(':')
        lines.push(`Revoked inbound tcp/${p} from ${cidr} on your security group ${g}`)
      }
      if (cfg.aws.existingSecurityGroupId) lines.push(`Kept pre-existing security group ${cfg.aws.existingSecurityGroupId}`)
      if (c.some((x) => x.type === 'ecr')) lines.push(`ECR image ${repo}:${runId} deleted; empty ECR repository ${repo} deleted`)
      const envCount = Object.keys(cfg.env ?? {}).length
      if (envCount) lines.push(`${envCount} SSM env parameter(s) deleted`)
      if (!cfg.aws.existingInstanceId) lines.push('Kept shared IAM role/instance profile BuildDoctorEC2Role (reused by other runs)')
      tornDown = true
      dashboardOn = false
      return { deleted: lines }
    },
  }
}
