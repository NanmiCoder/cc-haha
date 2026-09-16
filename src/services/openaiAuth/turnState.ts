/** One agentic user turn, never a whole conversation or shared agent session. */
export class OpenAICodexTurnState {
  #value: string | undefined
  #closed = false
  readonly #signal: AbortSignal
  readonly #onAbort = () => this[Symbol.dispose]()

  constructor(signal: AbortSignal) {
    this.#signal = signal
    if (signal.aborted) this.#closed = true
    else signal.addEventListener('abort', this.#onAbort, { once: true })
  }

  get(): string | undefined {
    return this.#closed ? undefined : this.#value
  }

  capture(value: string | null): void {
    // Match Codex's OnceLock: the first response owns routing for this turn.
    if (!this.#closed && this.#value === undefined && value) this.#value = value
  }

  [Symbol.dispose](): void {
    this.#closed = true
    this.#value = undefined
    this.#signal.removeEventListener('abort', this.#onAbort)
  }
}
