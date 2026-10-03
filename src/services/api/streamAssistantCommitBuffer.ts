/**
 * Holds completed, side-effect-free assistant blocks until a stream either
 * finishes or crosses a tool boundary. A watchdog retry can then discard the
 * failed attempt without leaving orphan thinking/text in the transcript.
 *
 * With deferToolUseCommit, a completed local tool_use crosses the boundary but
 * stays held too, so it is never handed to the tool executor before the
 * response completes. Whether an attempt can still be discarded and re-sent is
 * therefore hasCommitted(), not hasCrossedSideEffectBoundary().
 */
export class StreamAssistantCommitBuffer<T> {
  private pending: Array<{ value: T; blockType: string }> = []
  private crossedSideEffectBoundary = false
  private committed = false

  constructor(
    private readonly options: { deferToolUseCommit?: boolean } = {},
  ) {}

  add(value: T, blockType: string): T[] {
    if (this.crossedSideEffectBoundary) {
      if (!this.options.deferToolUseCommit) return this.commit([value])
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
    return this.commit(values)
  }

  hasPendingToolUse(): boolean {
    return this.pending.some(entry => entry.blockType === 'tool_use')
  }

  hasCrossedSideEffectBoundary(): boolean {
    return this.crossedSideEffectBoundary
  }

  /** True once any block was handed out to be yielded to the consumer. */
  hasCommitted(): boolean {
    return this.committed
  }

  private drain(): T[] {
    const values = this.pending.map(entry => entry.value)
    this.pending = []
    return this.commit(values)
  }

  private commit(values: T[]): T[] {
    if (values.length > 0) this.committed = true
    return values
  }
}
