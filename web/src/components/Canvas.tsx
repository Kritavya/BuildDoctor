import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap, Position,
  MarkerType, ReactFlow, getSmoothStepPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react'
import { Check, Clock, LoaderCircle, Minus, RotateCcw, X } from 'lucide-react'
import { PIPELINE, RETRY_EDGES, type NodeId, type NodeStatus } from '../contract'
import { NODE_META } from '../meta'
import { retryKey, type NodeView, type RunUi } from '../state'

const W_WIDE = 196
const W_STACKED = 176 // narrow canvases: slimmer cards so the local row still fits at a readable zoom
const H = 104
const GAP = 36
const GAP_STACKED = 24
const ROW_GAP = 186 // vertical distance between the bottom of one row and the top of the next
const PAD_X = 28
const PAD_TOP = 92
const PAD_BOTTOM = 20
const MIN_FIT_ZOOM = 0.7
const MAX_FIT_ZOOM = 1
const INSPECTOR_W = 392 + 24
const EDGE = 24 // breathing room around the graph, screen px
const CHROME_BOTTOM = 112 // controls + minimap live in the bottom corners
const MINIMAP_MIN_H = 560 // shorter canvases drop the minimap and use the full height
const chromeFor = (h: number) => (h >= MINIMAP_MIN_H ? CHROME_BOTTOM : EDGE)

const LOCAL = PIPELINE.filter((id) => NODE_META[id].stage === 'local')
const CLOUD = PIPELINE.filter((id) => NODE_META[id].stage === 'cloud')

export type LayoutMode = 'wide' | 'stacked'

interface Layout {
  nodeW: number
  pos: Record<NodeId, { x: number; y: number }>
  rowOf: Record<NodeId, number>
  stages: StageNode[]
  bounds: { x: number; y: number; w: number; h: number }
}


/** wide: local 6 / cloud 7. stacked: local 6 / cloud 4 + 3, for narrow canvases. */
function buildLayout(mode: LayoutMode): Layout {
  const W = mode === 'wide' ? W_WIDE : W_STACKED
  const gap = mode === 'wide' ? GAP : GAP_STACKED
  const rowWidth = (n: number) => n * W + (n - 1) * gap
  const rows: NodeId[][] = mode === 'wide'
    ? [LOCAL, CLOUD]
    : [LOCAL, CLOUD.slice(0, 4), CLOUD.slice(4)]
  const pos = {} as Layout['pos']
  const rowOf = {} as Layout['rowOf']
  const rowY: number[] = []
  let y = 0
  rows.forEach((row, r) => {
    // a new stage needs room for its label; a continuation row only for retry arcs
    if (r > 0) y += H + (NODE_META[row[0]].stage === NODE_META[rows[r - 1][0]].stage ? 112 : ROW_GAP)
    rowY.push(y)
    row.forEach((id, i) => {
      pos[id] = { x: i * (W + gap), y }
      rowOf[id] = r
    })
  })
  const stageBox = (stage: 'local' | 'cloud', label: string, sub: string): StageNode => {
    const rs = rows.map((row, i) => ({ row, i })).filter(({ row }) => NODE_META[row[0]].stage === stage)
    const top = rowY[rs[0].i]
    const bottom = rowY[rs[rs.length - 1].i] + H
    return {
      id: `stage-${stage}`, type: 'stage', position: { x: -PAD_X, y: top - PAD_TOP },
      data: { label, sub, width: Math.max(...rs.map(({ row }) => rowWidth(row.length))) + PAD_X * 2, height: bottom - top + PAD_TOP + PAD_BOTTOM },
      draggable: false, selectable: false, focusable: false, zIndex: -1,
    }
  }
  const stages = [
    stageBox('local', 'Local validation', 'Runs on this machine'),
    stageBox('cloud', 'AWS deployment', 'Your account, after you approve'),
  ]
  const maxW = Math.max(...rows.map((r) => rowWidth(r.length))) + PAD_X * 2
  return { nodeW: W, pos, rowOf, stages, bounds: { x: -PAD_X, y: -PAD_TOP, w: maxW, h: rowY[rowY.length - 1] + H + PAD_TOP + PAD_BOTTOM } }
}

const LAYOUTS: Record<LayoutMode, Layout> = { wide: buildLayout('wide'), stacked: buildLayout('stacked') }

function fitZoom(l: Layout, w: number, h: number) {
  const zw = (w - EDGE * 2) / l.bounds.w
  const zh = (h - EDGE - chromeFor(h)) / l.bounds.h
  return Math.min(zw, zh, MAX_FIT_ZOOM)
}

/** Wide layout when it stays readable, otherwise stack the AWS row. */
function chooseMode(w: number, h: number): LayoutMode {
  const wide = fitZoom(LAYOUTS.wide, w, h)
  if (wide >= MIN_FIT_ZOOM) return 'wide'
  return fitZoom(LAYOUTS.stacked, w, h) > wide ? 'stacked' : 'wide'
}

/** Viewport that shows the whole graph if it fits at a readable zoom; otherwise keeps `focus` in view. */
function computeViewport(l: Layout, w: number, h: number, focus?: NodeId) {
  const zoom = Math.max(MIN_FIT_ZOOM, Math.min(fitZoom(l, w, h), MAX_FIT_ZOOM))
  const cw = l.bounds.w * zoom
  const ch = l.bounds.h * zoom
  let x: number
  if (cw <= w - EDGE * 2) x = (w - cw) / 2 - l.bounds.x * zoom
  else {
    const fx = focus ? l.pos[focus].x + l.nodeW / 2 : l.bounds.x
    x = w / 2 - fx * zoom
    // don't scroll past either end of the graph
    x = Math.min(x, EDGE - l.bounds.x * zoom)
    x = Math.max(x, w - EDGE - (l.bounds.x + l.bounds.w) * zoom)
  }
  const room = h - chromeFor(h)
  let y = ch <= room ? Math.max(EDGE, (room - ch) / 2) - l.bounds.y * zoom : EDGE - l.bounds.y * zoom
  if (ch > room && focus) {
    const fy = l.pos[focus].y + H / 2
    y = Math.min(EDGE - l.bounds.y * zoom, Math.max(h / 2 - fy * zoom, h - EDGE - (l.bounds.y + l.bounds.h) * zoom))
  }
  return { x, y, zoom }
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

const StepCard = memo(function StepCard({ data, selected, width }: NodeProps<StepNode>) {
  const { id, view, ghost } = data
  const meta = NODE_META[id]
  const Icon = meta.icon
  const StatusIcon = STATUS_ICON[view.status]
  const attempt = view.attempt && view.attempt > 1 ? view.attempt : undefined
  const isRetryTarget = RETRY_EDGES.some(([, to]) => to === id)
  const isRetrySource = RETRY_EDGES.some(([from]) => from === id)
  return (
    <div style={{ width }} className={`step is-${view.status}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}>
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
  /** Changes when the surrounding layout changes on purpose (form toggled, run started...). */
  layoutKey: string
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number }>()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function Canvas({ run, selected, ghost, onSelect, layoutKey }: CanvasProps) {
  const host = useRef<HTMLDivElement>(null)
  const size = useSize(host)
  const rf = useReactFlow()
  const userMoved = useRef(false)
  const [mode, setMode] = useState<LayoutMode>('wide')
  const layout = LAYOUTS[mode]

  // The layout mode only follows the canvas width; the inspector overlays and never re-wraps rows.
  useEffect(() => {
    if (size) setMode(chooseMode(size.w, size.h))
  }, [size])

  const active = PIPELINE.find((id) => run.nodes[id].status === 'running' || run.nodes[id].status === 'waiting')
    ?? [...PIPELINE].reverse().find((id) => run.nodes[id].status === 'failed')
  const focus = selected ?? active
  const availW = size ? Math.max(240, size.w - (selected ? INSPECTOR_W : 0)) : 0

  const fit = (animate = true) => {
    if (!size) return
    void rf.setViewport(computeViewport(layout, availW, size.h, focus), { duration: animate ? 280 : 0 })
  }
  const fitRef = useRef(fit)
  fitRef.current = fit

  // Deliberate layout changes always refit and forget manual zoom.
  const first = useRef(true)
  useEffect(() => {
    if (!size) return
    userMoved.current = false
    fitRef.current(!first.current)
    first.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, mode, !!size])

  // Plain resizes and the run moving to the next step refit only if the user hasn't zoomed or panned.
  useEffect(() => {
    if (!size || first.current || userMoved.current) return
    const t = window.setTimeout(() => fitRef.current(), 120)
    return () => window.clearTimeout(t)
  }, [size, active])

  // Opening the inspector: keep the selected step clear of the panel.
  useEffect(() => {
    if (!size || !selected) return
    if (!userMoved.current) return fitRef.current()
    const vp = rf.getViewport()
    const p = layout.pos[selected]
    const left = p.x * vp.zoom + vp.x
    const right = (p.x + layout.nodeW) * vp.zoom + vp.x
    let dx = 0
    if (right > availW - EDGE) dx = availW - EDGE - right
    if (left + dx < EDGE) dx = EDGE - left
    if (dx) void rf.setViewport({ ...vp, x: vp.x + dx }, { duration: 280 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const nodes = useMemo<Array<StepNode | StageNode>>(() => [
    ...layout.stages,
    ...PIPELINE.map<StepNode>((id) => ({
      id, type: 'step', position: layout.pos[id], width: layout.nodeW, height: H,
      data: { id, view: run.nodes[id], ghost },
      selected: selected === id, draggable: false, connectable: false,
    })),
  ], [run.nodes, selected, ghost, layout])

  const edges = useMemo<Array<FlowEdgeT | RetryEdgeT>>(() => {
    const flow: FlowEdgeT[] = PIPELINE.slice(0, -1).map((from, i) => {
      const to = PIPELINE[i + 1]
      const wrap = layout.rowOf[from] !== layout.rowOf[to]
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
  }, [run.nodes, run.retries, ghost, layout])

  return (
    <div className="rf-host" ref={host}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => n.type === 'step' && onSelect(n.id as NodeId)}
      onPaneClick={() => onSelect(null)}
      onMoveStart={(e) => {
        if (e) userMoved.current = true
      }}
      colorMode={(document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? 'system'}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.3} className="canvas-bg" />
      <Controls showInteractive={false} position="bottom-left"
        onZoomIn={() => (userMoved.current = true)} onZoomOut={() => (userMoved.current = true)} onFitView={() => {
        userMoved.current = false
        fit()
      }} />
      {size && size.h >= MINIMAP_MIN_H && <MiniMap
        position="bottom-right"
        style={{ width: 176, height: 104 }}
        pannable
        zoomable
        nodeBorderRadius={6}
        nodeClassName={(n) => (n.type === 'stage' ? 'mm-stage' : `mm-step is-${(n.data as StepData).view.status}`)}
        maskColor="var(--minimap-mask)"
      />}
    </ReactFlow>
    </div>
  )
}
