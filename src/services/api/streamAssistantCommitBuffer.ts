/**
 * Holds completed, side-effect-free assistant blocks until a stream either
 * finishes or crosses a tool boundary. A watchdog retry can then discard the
 * failed attempt without leaving orphan thinking/text in the transcript.
 */
export class StreamAssistantCommitBuffer<T> {
  private pending: Array<{ value: T; blockType: string }> = []
  private crossedSideEffectBoundary = false

  constructor(
    private readonly options: { deferToolUseCommit?: boolean } = {},
  ) {}

  add(value: T, blockType: string): T[] {
    if (this.crossedSideEffectBoundary) {
      if (!this.options.deferToolUseCommit) return [value]
      this.pending.push({ value, blockType })
      return []
    }

    this.pending.push({ value, blockType })
    if (blockType !== 'tool_use' && blockType !== 'server_tool_use') {
      return []
    }

    this.crossedSideEffectBoundary = true
    if (this.options.deferToolUseCommit && blockType === 'tool_use') {
      return []
    }
    return this.drain()
  }

  flush(): T[] {
    return this.drain()
  }

  flushWithoutToolUse(): T[] {
    const values = this.pending
      .filter(entry => entry.blockType !== 'tool_use')
      .map(entry => entry.value)
    this.pending = []
    return values
  }

  hasPendingToolUse(): boolean {
    return this.pending.some(entry => entry.blockType === 'tool_use')
  }

  hasCrossedSideEffectBoundary(): boolean {
    return this.crossedSideEffectBoundary
  }

  private drain(): T[] {
    const values = this.pending.map(entry => entry.value)
    this.pending = []
    return values
  }
}
