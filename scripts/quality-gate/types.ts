export type QualityGateMode = 'pr' | 'baseline' | 'release'

export type LaneKind = 'command' | 'baseline-case' | 'desktop-smoke' | 'provider-smoke'

export type LaneCategory =
  | 'scope'
  | 'governance'
  | 'unit'
  | 'coverage'
  | 'integration'
  | 'smoke'
  | 'native'
  | 'docs'

export type LaneDefinition = {
  id: string
  title: string
  description: string
  kind: LaneKind
  command?: string[]
  impactRequiredCheck?: string
  baselineCaseId?: string
  baselineTarget?: BaselineTarget
  requiredForModes: QualityGateMode[]
  category?: LaneCategory
  live?: boolean
}

export type BaselineCase = {
  id: string
  title: string
  description: string
  fixture: string
  prompt: string
  mode: 'ui' | 'websocket'
  requiredCapabilities: Array<'model' | 'file-edit' | 'shell' | 'permission' | 'browser'>
  timeoutMs: number
  verify: {
    commands: string[][]
    requiredFiles?: string[]
    expectedFiles?: string[]
    forbiddenFiles?: string[]
    transcriptAssertions?: string[]
  }
}

export type BaselineTarget = {
  providerId: string | null
  modelId: string
  label: string
}

export type LaneStatus = 'passed' | 'failed' | 'skipped'

export type LaneResult = {
  id: string
  title: string
  description?: string
  category?: LaneCategory
  live?: boolean
  status: LaneStatus
  command?: string[]
  durationMs: number
  exitCode?: number
  skipReason?: string
  error?: string
  artifactDir?: string
  logPath?: string
}

export type ImpactSummary = {
  changedFiles?: number
  areas: string[]
  labels: string[]
  blocked?: boolean
  requiredChecks: string[]
  testCoverageSignals: string[]
  riskNotes: string[]
}

export type CoverageMetricSummary = {
  pct: number
  covered: number
  total: number
}

export type CoverageSuiteSummary = {
  id: string
  title: string
  status: string
  lines?: CoverageMetricSummary
  functions?: CoverageMetricSummary
  branches?: CoverageMetricSummary
  statements?: CoverageMetricSummary
}

export type ReportArtifact = {
  title: string
  path: string
}

export type QualityGateOptions = {
  mode: QualityGateMode
  dryRun: boolean
  allowLive: boolean
  baselineTargets: BaselineTarget[]
  rootDir: string
  artifactsDir?: string
  runOutputDir?: string
  runId?: string
  onlyLaneSelectors?: string[]
  skipLaneSelectors?: string[]
}

export type QualityGateReport = {
  schemaVersion: 1
  runId: string
  mode: QualityGateMode
  dryRun: boolean
  allowLive: boolean
  startedAt: string
  finishedAt: string
  rootDir: string
  git: {
    sha: string | null
    dirty: boolean
  }
  results: LaneResult[]
  impact?: ImpactSummary
  coverage?: {
    reportPath: string
    suites: CoverageSuiteSummary[]
    failures: string[]
  }
  artifacts: ReportArtifact[]
  summary: {
    passed: number
    failed: number
    skipped: number
  }
}
