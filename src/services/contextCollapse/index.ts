interface CollapseStats {
  collapsedSpans: number
  stagedSpans: number
  health: {
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
  }
}

let stats: CollapseStats = {
  collapsedSpans: 0,
  stagedSpans: 0,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false
  }
}

export function getStats(): CollapseStats {
  return stats
}

export function subscribe(callback: () => void): () => void {
  return () => {}
}