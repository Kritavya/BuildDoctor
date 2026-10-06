import type { InstanceSize, RunConfig } from './contract'

export interface EnvRow {
  id: number
  key: string
  value: string
}

export interface FormState {
  repoUrl: string
  branch: string
  appPort: string
  env: EnvRow[]
  region: string
  instanceType: InstanceSize
  openPorts: number[]
  existingInstanceId: string
  existingSecurityGroupId: string
  maxFixAttempts: number
}

let envSeq = 0
export const newEnvRow = (key = '', value = ''): EnvRow => ({ id: ++envSeq, key, value })

export function defaultForm(prefill: boolean): FormState {
  return {
    repoUrl: prefill ? 'https://github.com/acme/notes-api' : '',
    branch: '',
    appPort: '',
    env: prefill
      ? [newEnvRow('DATABASE_URL', 'postgres://notes:s3cret@db.internal:5432/notes'), newEnvRow('JWT_SECRET', 'k9-2f81c0ab77')]
      : [newEnvRow()],
    region: 'ap-south-1',
    instanceType: 't4g.small',
    openPorts: [80],
    existingInstanceId: '',
    existingSecurityGroupId: '',
    maxFixAttempts: 3,
  }
}

const GITHUB_RE = /^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/i

export function validate(f: FormState): Partial<Record<'repoUrl' | 'appPort', string>> {
  const errors: Partial<Record<'repoUrl' | 'appPort', string>> = {}
  if (!f.repoUrl.trim()) errors.repoUrl = 'Paste the GitHub link to your repository.'
  else if (!GITHUB_RE.test(f.repoUrl.trim())) errors.repoUrl = 'Use a link like https://github.com/owner/repo'
  if (f.appPort) {
    const p = Number(f.appPort)
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.appPort = 'Ports are whole numbers from 1 to 65535.'
  }
  return errors
}

// Rebuilds the form from a stored run. Env values are never sent back by the server, so only keys return.
export function fromRunConfig(c: RunConfig): FormState {
  return {
    repoUrl: c.repoUrl,
    branch: c.branch ?? '',
    appPort: c.appPort ? String(c.appPort) : '',
    env: Object.keys(c.env ?? {}).map((k) => newEnvRow(k, '')),
    region: c.aws.region,
    instanceType: c.aws.instanceType,
    openPorts: c.aws.openPorts ?? [],
    existingInstanceId: c.aws.existingInstanceId ?? '',
    existingSecurityGroupId: c.aws.existingSecurityGroupId ?? '',
    maxFixAttempts: c.maxFixAttempts ?? 3,
  }
}

export function toRunConfig(f: FormState): RunConfig {
  const env: Record<string, string> = {}
  for (const r of f.env) if (r.key.trim()) env[r.key.trim()] = r.value
  let repoUrl = f.repoUrl.trim()
  if (!/^https?:\/\//.test(repoUrl)) repoUrl = 'https://' + repoUrl
  return {
    repoUrl,
    branch: f.branch.trim() || undefined,
    appPort: f.appPort ? Number(f.appPort) : undefined,
    env: Object.keys(env).length ? env : undefined,
    aws: {
      region: f.region,
      instanceType: f.instanceType,
      openPorts: f.openPorts,
      existingInstanceId: f.existingInstanceId.trim() || undefined,
      existingSecurityGroupId: f.existingSecurityGroupId.trim() || undefined,
    },
    maxFixAttempts: f.maxFixAttempts,
  }
}

export function repoLabel(url: string): string {
  return url.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$|\/$/g, '')
}
