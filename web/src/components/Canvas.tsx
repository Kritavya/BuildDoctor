import { memo, useEffect, useMemo } from 'react'
import {
  Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap, Position,
  MarkerType, ReactFlow, getSmoothStepPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react'
import { Check, Clock, LoaderCircle, Minus, RotateCcw, X } from 'lucide-react'
import { PIPELINE, RETRY_EDGES, type NodeId, type NodeStatus } from '../contract'
import { NODE_META } from '../meta'
import { retryKey, type NodeView, type RunUi } from '../state'

const W = 196
const H = 104
const GAP = 36
const ROW_Y = { local: 0, cloud: 290 }
const PAD_X = 28
const PAD_TOP = 92
const PAD_BOTTOM = 20

const FIT_PADDING = { top: '28px', left: '28px', right: '28px', bottom: '128px' } as const

const LOCAL = PIPELINE.filter((id) => NODE_META[id].stage === 'local')
const CLOUD = PIPELINE.filter((id) => NODE_META[id].stage === 'cloud')

function position(id: NodeId) {
  const stage = NODE_META[id].stage
  const row = stage === 'local' ? LOCAL : CLOUD
  return { x: row.indexOf(id) * (W + GAP), y: ROW_Y[stage] }
}

// ---------- nodes ----------

type StepData = { id: NodeId; view: NodeView; ghost: boolean }
type StageData = { label: string; sub: string; width: number; height: number }
type StepNode = Node<StepData, 'step'>
type StageNode = Node<StageData, 'stage'>

const STATUS_ICON: Record<NodeStatus, typeof Check | null> = {
  idle: null, running: LoaderCircle, success: Check, failed: X, waiting: Clock, skipped: Minus,
}

/** Small heart-monitor trace at the bottom of each card. */
function Vitals({ status }: { status: NodeStatus }) {
  const beat = 'l5 0 l3 -5 l3 10 l3 -13 l3 11 l2 -3 l5 0'
  const flat = 'M0 10 H204'
  const d = status === 'idle' || status === 'skipped'
    ? flat
    : `M0 10 h24 ${beat} h40 ${beat} h40 ${beat} h40`
  return (
    <svg className="vitals" viewBox="0 0 204 20" preserveAspectRatio="none" aria-hidden>
      <path d={d} pathLength={100} />
    </svg>
  )
}

const StepCard = memo(function StepCard({ data, selected }: NodeProps<StepNode>) {
  const { id, view, ghost } = data
  const meta = NODE_META[id]
  const Icon = meta.icon
  const StatusIcon = STATUS_ICON[view.status]
  const attempt = view.attempt && view.attempt > 1 ? view.attempt : undefined
  const isRetryTarget = RETRY_EDGES.some(([, to]) => to === id)
  const isRetrySource = RETRY_EDGES.some(([from]) => from === id)
  return (
    <div className={`step is-${view.status}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}>
      <Handle type="target" position={Position.Left} id="in" className="h h--side" />
      <Handle type="source" position={Position.Right} id="out" className="h h--side" />
      <Handle type="source" position={Position.Bottom} id="out-bottom" className="h h--hidden" />
      {isRetryTarget && <Handle type="target" position={Position.Top} id="retry-in" className="h h--hidden" style={{ left: '30%' }} />}
      {isRetrySource && <Handle type="source" position={Position.Top} id="retry-out" className="h h--hidden" style={{ left: '70%' }} />}

      {attempt && <span className="step-attempt" title={`Attempt ${attempt}`}><RotateCcw size={10} strokeWidth={2.6} />×{attempt}</span>}
      <div className="step-top">
        <span className="step-icon"><Icon size={17} strokeWidth={1.9} /></span>
        <span className="step-title">{meta.title}</span>
        {StatusIcon && (
          <span className="step-status" aria-label={view.status}>
            <StatusIcon size={12} strokeWidth={2.6} className={view.status === 'running' ? 'spin' : undefined} />
          </span>
        )}
      </div>
      <p className="step-summary" title={view.summary ?? meta.blurb}>{view.summary ?? meta.blurb}</p>
      <Vitals status={view.status} />
    </div>
  )
})

function StageBox({ data }: NodeProps<StageNode>) {
  return (
    <div className="stage" style={{ width: data.width, height: data.height }}>
      <div className="stage-label">
        <span className="stage-name">{data.label}</span>
        <span className="stage-sub">{data.sub}</span>
      </div>
    </div>
  )
}

// ---------- edges ----------

type FlowState = 'idle' | 'active' | 'done' | 'failed'
type FlowEdgeT = Edge<{ state: FlowState; offset?: number }, 'flow'>
type RetryEdgeT = Edge<{ attempt?: number; live: boolean }, 'retry'>

function FlowEdge(p: EdgeProps<FlowEdgeT>) {
  const [path] = getSmoothStepPath({
    sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY,
    sourcePosition: p.sourcePosition, targetPosition: p.targetPosition, borderRadius: 14, offset: p.data?.offset ?? 22,
  })
  return <BaseEdge id={p.id} path={path} className={`flow-edge is-${p.data?.state ?? 'idle'}`} />
}

function RetryEdge(p: EdgeProps<RetryEdgeT>) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = p
  const h = Math.min(96, 36 + Math.abs(sx - tx) * 0.09)
  const path = `M ${sx} ${sy} C ${sx} ${sy - h}, ${tx} ${ty - h}, ${tx} ${ty}`
  const lx = (sx + tx) / 2
  const ly = Math.min(sy, ty) - h * 0.75
  const fired = p.data?.attempt !== undefined
  return (
    <>
      <BaseEdge id={p.id} path={path} className={`retry-edge${fired ? ' is-fired' : ''}${p.data?.live ? ' is-live' : ''}`}
        markerEnd={p.markerEnd} />
      {fired && (
        <EdgeLabelRenderer>
          <div className={`retry-pill${p.data?.live ? ' is-live' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            <RotateCcw size={11} strokeWidth={2.4} /> attempt {p.data?.attempt}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { step: StepCard, stage: StageBox }
const edgeTypes = { flow: FlowEdge, retry: RetryEdge }

function rowWidth(n: number) {
  return n * W + (n - 1) * GAP
}

const STAGES: StageNode[] = [
  {
    id: 'stage-local', type: 'stage', position: { x: -PAD_X, y: ROW_Y.local - PAD_TOP },
    data: { label: 'Local validation', sub: 'Runs on this machine', width: rowWidth(LOCAL.length) + PAD_X * 2, height: H + PAD_TOP + PAD_BOTTOM },
    draggable: false, selectable: false, focusable: false, zIndex: -1,
  },
  {
    id: 'stage-cloud', type: 'stage', position: { x: -PAD_X, y: ROW_Y.cloud - PAD_TOP },
    data: { label: 'AWS deployment', sub: 'Your account, after you approve', width: rowWidth(CLOUD.length) + PAD_X * 2, height: H + PAD_TOP + PAD_BOTTOM },
    draggable: false, selectable: false, focusable: false, zIndex: -1,
  },
]

function flowState(a: NodeView, b: NodeView): FlowState {
  if (b.status === 'running' || b.status === 'waiting') return 'active'
  if (a.status === 'success' && (b.status === 'success' || b.status === 'skipped')) return 'done'
  if (b.status === 'failed') return 'failed'
  return 'idle'
}

interface CanvasProps {
  run: RunUi
  selected: NodeId | null
  ghost: boolean
  onSelect: (id: NodeId | null) => void
}

/** Refits the graph whenever the canvas changes size (panels opening, result card, window resize). */
function FitOnResize() {
  const rf = useReactFlow()
  useEffect(() => {
    const el = document.querySelector('.canvas-wrap')
    if (!el) return
    let t: number | undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false)
      window.clearTimeout(t)
      t = window.setTimeout(() => void rf.fitView({ padding: FIT_PADDING, duration: 250 }), 120)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      window.clearTimeout(t)
    }
  }, [rf])
  return null
}

export function Canvas({ run, selected, ghost, onSelect }: CanvasProps) {
  const nodes = useMemo<Array<StepNode | StageNode>>(() => [
    ...STAGES,
    ...PIPELINE.map<StepNode>((id) => ({
      id, type: 'step', position: position(id), width: W, height: H,
      data: { id, view: run.nodes[id], ghost },
      selected: selected === id, draggable: false, connectable: false,
    })),
  ], [run.nodes, selected, ghost])

  const edges = useMemo<Array<FlowEdgeT | RetryEdgeT>>(() => {
    const flow: FlowEdgeT[] = PIPELINE.slice(0, -1).map((from, i) => {
      const to = PIPELINE[i + 1]
      const wrap = NODE_META[from].stage !== NODE_META[to].stage
      return {
        id: `e-${from}-${to}`, source: from, target: to, type: 'flow',
        sourceHandle: wrap ? 'out-bottom' : 'out', targetHandle: 'in',
        data: { state: ghost ? 'idle' : flowState(run.nodes[from], run.nodes[to]), offset: wrap ? 44 : 22 },
        selectable: false, focusable: false,
      }
    })
    const latest = Object.entries(run.retries).sort((a, b) => b[1].seq - a[1].seq)[0]?.[0]
    const retry: RetryEdgeT[] = RETRY_EDGES.map(([from, to]) => {
      const mark = run.retries[retryKey(from, to)]
      const live = !!mark && latest === retryKey(from, to) && run.nodes[from].status !== 'success'
      return {
        id: `r-${from}-${to}`, source: from, target: to, type: 'retry',
        sourceHandle: 'retry-out', targetHandle: 'retry-in',
        data: { attempt: mark?.attempt, live }, selectable: false, focusable: false,
        markerEnd: mark ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--retry)' } : undefined,
      }
    })
    return [...flow, ...retry]
  }, [run.nodes, run.retries, ghost])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: FIT_PADDING }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => n.type === 'step' && onSelect(n.id as NodeId)}
      onPaneClick={() => onSelect(null)}
      colorMode={(document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? 'system'}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.3} className="canvas-bg" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        position="bottom-right"
        style={{ width: 176, height: 104 }}
        pannable
        zoomable
        nodeBorderRadius={6}
        nodeClassName={(n) => (n.type === 'stage' ? 'mm-stage' : `mm-step is-${(n.data as StepData).view.status}`)}
        maskColor="var(--minimap-mask)"
      />
      <FitOnResize />
    </ReactFlow>
  )
}
