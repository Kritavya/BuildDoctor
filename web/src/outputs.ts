// Type guards for node outputs (kept out of component files for fast refresh).
import type { AnalysisResult, Diagnosis } from './contract'

export const isAnalysis = (d: unknown): d is AnalysisResult =>
  typeof d === 'object' && d !== null && 'runtime' in d && 'dockerfile' in d
export const isDiagnosis = (d: unknown): d is Diagnosis =>
  typeof d === 'object' && d !== null && 'rootCause' in d && 'evidence' in d
export const looksLikeDockerfile = (d: unknown): d is string => typeof d === 'string' && /^\s*(#.*\n\s*)*FROM\s/im.test(d)

