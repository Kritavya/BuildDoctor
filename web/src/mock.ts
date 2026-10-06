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
import type { Diagnosis, NodeId, NodeStatus, RunConfig, RunEvent } from './contract'

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

function script(cfg: RunConfig): Entry[] {
  const repo = cfg.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || 'acme/notes-api'
  const name = repo.split('/').pop() || 'app'
  const branch = cfg.branch || 'main'
  const port = cfg.appPort || 3000
  const region = cfg.aws.region
  const size = cfg.aws.instanceType
  const ports = Array.from(new Set([port, ...cfg.aws.openPorts])).sort((a, b) => a - b)
  const ip = '13.233.41.20'
  const appUrl = `http://${ip}:${port}`

  const out: Entry[] = []
  const node = (d: number, n: NodeId, status: NodeStatus, summary?: string, attempt?: number) =>
    out.push({ d, ev: { type: 'node', node: n, status, summary, attempt } })
  const log = (d: number, n: NodeId, line: string) => out.push({ d, ev: { type: 'log', node: n, line } })
  const output = (d: number, n: NodeId, data: unknown) => out.push({ d, ev: { type: 'output', node: n, data } })

  node(200, 'clone', 'running', `Cloning ${repo}`)
  log(150, 'clone', `$ git clone --depth 1 --branch ${branch} https://github.com/${repo}.git`)
  log(500, 'clone', 'Receiving objects: 100% (142/142), 88.4 KiB | 1.2 MiB/s, done.')
  log(200, 'clone', 'HEAD is now at 3f2c1a9 Add notes search endpoint')
  node(200, 'clone', 'success', `${branch} @ 3f2c1a9, 142 files`)

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
  node(150, 'analyze', 'success', `Express on Node 20, port ${port}`)

  node(250, 'dockerfile', 'running', 'Local model drafting a Dockerfile', 1)
  log(400, 'dockerfile', 'Prompting qwen2.5-coder:7b with project facts (secret values withheld)')
  log(1100, 'dockerfile', 'Draft received: 12 lines, base image node:20-alpine')
  output(100, 'dockerfile', DOCKERFILE_V1)
  node(150, 'dockerfile', 'success', 'Drafted 12 lines', 1)

  node(250, 'lint', 'running', 'hadolint', 1)
  log(500, 'lint', 'DL3018 info: pin versions in apk add (not applicable)')
  log(150, 'lint', 'ok 0 errors, 0 warnings')
  node(150, 'lint', 'success', '0 errors, 0 warnings', 1)

  node(250, 'build', 'running', `docker build -t ${name}:3f2c1a9`, 1)
  log(250, 'build', '#1 [internal] load build definition from Dockerfile')
  log(300, 'build', '#2 [1/6] FROM docker.io/library/node:20-alpine')
  log(400, 'build', '#5 [3/6] COPY package.json package-lock.json ./')
  log(700, 'build', '#6 [4/6] RUN npm ci   added 87 packages in 6s')
  log(300, 'build', '#7 [5/6] COPY . .')
  log(300, 'build', '#8 [6/6] RUN npm run build')
  log(250, 'build', 'ERROR npm ERR! Missing script: "build"')
  log(100, 'build', 'ERROR process "/bin/sh -c npm run build" did not complete successfully: exit code 1')
  node(200, 'build', 'failed', 'Missing script: "build"', 1)

  log(500, 'build', 'Doctor: reading the failing step and package.json scripts')
  out.push({ d: 900, ev: { type: 'retry', from: 'build', to: 'dockerfile', attempt: 2, diagnosis: BUILD_DIAGNOSIS } })
  output(0, 'build', BUILD_DIAGNOSIS)

  node(300, 'dockerfile', 'running', 'Applying the fix', 2)
  log(900, 'dockerfile', 'Removed "RUN npm run build"; switched to npm ci --omit=dev')
  output(100, 'dockerfile', DOCKERFILE_V2)
  node(150, 'dockerfile', 'success', 'Fixed: dropped the build step', 2)

  node(200, 'lint', 'running', 'hadolint', 2)
  log(400, 'lint', 'ok 0 errors, 0 warnings')
  node(100, 'lint', 'success', '0 errors, 0 warnings', 2)

  node(200, 'build', 'running', `docker build -t ${name}:3f2c1a9`, 2)
  log(300, 'build', '#2 [1/5] FROM docker.io/library/node:20-alpine (cached)')
  log(600, 'build', '#6 [3/5] RUN npm ci --omit=dev && npm cache clean --force')
  log(500, 'build', '#7 [4/5] COPY src ./src')
  log(300, 'build', `#9 naming to docker.io/library/${name}:3f2c1a9 done`)
  log(100, 'build', 'ok Image size 142 MB')
  node(150, 'build', 'success', 'Image built, 142 MB in 38s', 2)

  node(250, 'smoke', 'running', `Starting container on :${port}`)
  log(400, 'smoke', `$ docker run -d -p ${port}:${port} --env-file <masked> ${name}:3f2c1a9`)
  log(700, 'smoke', `Server listening on ${port}`)
  log(300, 'smoke', `GET http://localhost:${port}/  ->  200 OK in 41 ms`)
  node(150, 'smoke', 'success', `GET / returned 200 in 41 ms`)

  const actions = [
    `Create ECR repository "${name}" in ${region}`,
    `Create security group "builddoctor-${name}" opening ports ${ports.join(', ')}`,
    `Launch EC2 instance ${size} (arm64) in ${region}`,
    'Store 2 env vars as encrypted SSM parameters',
  ]
  node(250, 'approve', 'waiting', 'Waiting for your go-ahead')
  log(100, 'approve', 'Pipeline paused: review the AWS changes')
  out.push({ d: 100, ev: { type: 'approval', request: { actions } } })
  // --- the mock pauses here until approve() is called ---
  node(100, 'approve', 'success', 'Approved by you')

  node(200, 'ecr', 'running', 'Pushing image')
  log(300, 'ecr', `Created repository 172083944099.dkr.ecr.${region}.amazonaws.com/${name}`)
  log(800, 'ecr', 'Pushed 5 layers (58.2 MB compressed)')
  node(150, 'ecr', 'success', `Pushed ${name}:3f2c1a9`)

  node(200, 'securityGroup', 'running', 'Creating security group')
  log(500, 'securityGroup', `Created sg-0a91c4e27b3d55f10, inbound ${ports.join(', ')} from 0.0.0.0/0`)
  node(100, 'securityGroup', 'success', `Ports ${ports.join(', ')} open`)

  node(200, 'ec2', 'running', `Launching ${size}`)
  log(400, 'ec2', `RunInstances ${size} ami-al2023-arm64 in ${region}a`)
  log(1200, 'ec2', 'Instance i-0f3b2c9e71a4d8c55 is pending')
  log(1000, 'ec2', `Instance running, public IP ${ip}`)
  node(150, 'ec2', 'success', `i-0f3b2c9e71a4 at ${ip}`)

  node(200, 'deploy', 'running', 'Starting container on the instance')
  log(600, 'deploy', 'SSM: docker login to ECR, ok')
  log(800, 'deploy', `SSM: docker run -d --restart unless-stopped -p ${port}:${port} ${name}:3f2c1a9`)
  node(150, 'deploy', 'success', `Container up on :${port}`)

  node(200, 'health', 'running', `Probing ${appUrl}`)
  log(700, 'health', `GET ${appUrl}/  ->  200 OK in 88 ms (1/3)`)
  log(400, 'health', `GET ${appUrl}/  ->  200 OK in 74 ms (2/3)`)
  log(400, 'health', `ok GET ${appUrl}/  ->  200 OK in 71 ms (3/3)`)
  node(150, 'health', 'success', '3 of 3 checks passed')

  node(200, 'dashboard', 'skipped', 'Off. Turn it on from the live card')
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
  let ip = '13.233.41.20'

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
      entries = script(cfg)
      ip = '13.233.41.20'
      idx = 0
      pausedForApproval = false
      return 'demo-' + Math.random().toString(36).slice(2, 8)
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
    async dashboard(_id, enabled) {
      await new Promise((r) => setTimeout(r, 600))
      emit?.({
        type: 'node',
        node: 'dashboard',
        status: enabled ? 'success' : 'skipped',
        summary: enabled ? 'Metrics and logs running' : 'Off. Turn it on from the live card',
      })
      emit?.({
        type: 'log',
        node: 'dashboard',
        line: enabled ? 'SSM: started cadvisor on :8080 and dozzle on :9999' : 'SSM: stopped cadvisor and dozzle',
        ts: Date.now(),
      })
      return enabled
        ? { enabled: true, metricsUrl: `http://${ip}:8080`, logsUrl: `http://${ip}:9999` }
        : { enabled: false }
    },
    async teardown() {
      await new Promise((r) => setTimeout(r, 900))
      return {
        deleted: ['i-0f3b2c9e71a4d8c55', 'sg-0a91c4e27b3d55f10', `ecr/${cfg.repoUrl.split('/').pop() || 'app'}`, '/builddoctor/env/*'],
      }
    },
  }
}
