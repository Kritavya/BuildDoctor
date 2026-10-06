import {
  GitBranch, ScanSearch, FileCode2, ListChecks, Hammer, FlaskConical,
  UserCheck, Package, ShieldHalf, Server, Rocket, HeartPulse, Gauge,
  type LucideIcon,
} from 'lucide-react'
import type { InstanceSize, NodeId, NodeStatus } from './contract'

export type Stage = 'local' | 'cloud'

export interface NodeMeta {
  title: string
  blurb: string // shown on the card before the node has run
  icon: LucideIcon
  stage: Stage
}

export const NODE_META: Record<NodeId, NodeMeta> = {
  clone: { title: 'Clone repo', blurb: 'Fetch the branch you picked', icon: GitBranch, stage: 'local' },
  analyze: { title: 'Analyze project', blurb: 'Detect runtime, port and env vars', icon: ScanSearch, stage: 'local' },
  dockerfile: { title: 'Dockerfile', blurb: 'Use yours or draft one locally', icon: FileCode2, stage: 'local' },
  lint: { title: 'Lint Dockerfile', blurb: 'Catch mistakes before building', icon: ListChecks, stage: 'local' },
  build: { title: 'Build image', blurb: 'docker build on this machine', icon: Hammer, stage: 'local' },
  smoke: { title: 'Smoke test', blurb: 'Run it and hit the app port', icon: FlaskConical, stage: 'local' },
  approve: { title: 'Your approval', blurb: 'Nothing is created in AWS without it', icon: UserCheck, stage: 'cloud' },
  ecr: { title: 'Push to ECR', blurb: 'Upload the image to your registry', icon: Package, stage: 'cloud' },
  securityGroup: { title: 'Security group', blurb: 'Open only the ports you need', icon: ShieldHalf, stage: 'cloud' },
  ec2: { title: 'EC2 instance', blurb: 'Launch or reuse a server', icon: Server, stage: 'cloud' },
  deploy: { title: 'Deploy', blurb: 'Pull the image and start it', icon: Rocket, stage: 'cloud' },
  health: { title: 'Health check', blurb: 'Confirm the app answers', icon: HeartPulse, stage: 'cloud' },
  dashboard: { title: 'Dashboard', blurb: 'Optional metrics and logs', icon: Gauge, stage: 'cloud' },
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: 'Not started',
  running: 'Running',
  success: 'Done',
  failed: 'Failed',
  waiting: 'Waiting for you',
  skipped: 'Skipped',
}

export const INSTANCE_SIZES: Array<{ id: InstanceSize; spec: string; hint: string; monthly: number }> = [
  { id: 't4g.micro', spec: '2 vCPU, 1 GB', hint: 'Small APIs and demos', monthly: 6 },
  { id: 't4g.small', spec: '2 vCPU, 2 GB', hint: 'Most web apps start here', monthly: 12 },
  { id: 't4g.medium', spec: '2 vCPU, 4 GB', hint: 'Heavier apps, Next.js builds', monthly: 25 },
]

export const REGIONS: Array<{ id: string; name: string }> = [
  { id: 'ap-south-1', name: 'Mumbai' },
  { id: 'ap-southeast-1', name: 'Singapore' },
  { id: 'us-east-1', name: 'N. Virginia' },
  { id: 'us-west-2', name: 'Oregon' },
  { id: 'eu-west-1', name: 'Ireland' },
  { id: 'eu-central-1', name: 'Frankfurt' },
]

export const COMMON_PORTS: Array<{ port: number; label: string; hint: string }> = [
  { port: 80, label: 'HTTP', hint: 'Plain web traffic' },
  { port: 443, label: 'HTTPS', hint: 'Secure web traffic, if you add TLS later' },
  { port: 22, label: 'SSH', hint: 'Remote shell. Leave off unless you need it' },
]
