import type {
  BrowserControlStatePayload,
  BrowserCursorPayload,
  CdpTransport,
} from './types'

export const IN_PAGE_CURSOR_WORLD_NAME = '__cc_haha_browser_use_cursor__'
const TEARDOWN_TIMEOUT_MS = 150

/**
 * Generates a self-contained, Trusted-Types & strict-CSP safe top-frame
 * Closed Shadow DOM cursor script.
 *
 * Security invariants:
 * - Strictly top-frame only (`window === window.top`).
 * - ZERO `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `<style>` elements.
 * - Uses `document.createElementNS` + `new CSSStyleSheet()` / `adoptedStyleSheets`.
 * - Supports synchronous hide before screenshots and fast teardown.
 */
export function buildInPageCursorBootstrapScript(): string {
  return `(() => {
  if (typeof window === 'undefined' || window !== window.top) return;
  if (globalThis.__ccHahaCursor && typeof globalThis.__ccHahaCursor.move === 'function') return;

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOST_ATTR = 'data-cc-haha-browser-cursor';

  let host = null;
  let shadow = null;
  let cursorEl = null;
  let boxEl = null;
  let rippleEl = null;
  let pillEl = null;
  let pillDotEl = null;
  let pillTextEl = null;
  let borderEl = null;
  let idleTimer = null;
  let boxTimer = null;
  let rippleTimer = null;

  const STYLES = [
    ':host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; contain: layout style; }',
    '.cc-frame { position: fixed; inset: 0; pointer-events: none; box-sizing: border-box; border: 2px solid transparent; transition: border-color 180ms ease; }',
    '.cc-frame.active { border-color: rgba(6, 182, 212, 0.45); }',
    '.cc-frame.takeover { border-color: rgba(245, 158, 11, 0.85); box-shadow: inset 0 0 24px rgba(245, 158, 11, 0.25); }',
    '.cc-box { position: fixed; left: 0; top: 0; width: 0; height: 0; border-radius: 6px; border: 2px solid rgba(6, 182, 212, 0.9); background: rgba(6, 182, 212, 0.12); opacity: 0; pointer-events: none; transition: opacity 120ms ease; }',
    '.cc-cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; pointer-events: none; opacity: 0; transform: translate3d(-100px, -100px, 0); filter: drop-shadow(0 2px 6px rgba(6, 182, 212, 0.55)); will-change: transform, opacity; }',
    '.cc-ripple { position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin-left: -14px; margin-top: -14px; border-radius: 9999px; border: 2px solid rgba(6, 182, 212, 0.9); opacity: 0; pointer-events: none; transform: translate3d(-100px, -100px, 0) scale(0.3); }',
    '.cc-pill { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: none; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 9999px; background: rgba(15, 23, 42, 0.9); color: #f8fafc; font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28); border: 1px solid rgba(148, 163, 184, 0.28); pointer-events: none; max-width: 72vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.cc-pill.visible { display: inline-flex; }',
    '.cc-dot { width: 8px; height: 8px; border-radius: 9999px; background: #06b6d4; flex-shrink: 0; }',
    '.cc-pill.takeover .cc-dot { background: #f59e0b; }'
  ].join('\\n');

  function ensureMounted() {
    if (host && host.isConnected) return true;
    const root = document.documentElement || document.body;
    if (!root) return false;

    host = document.createElementNS(HTML_NS, 'div');
    host.setAttribute(HOST_ATTR, 'true');
    host.setAttribute('aria-hidden', 'true');
    shadow = host.attachShadow({ mode: 'closed' });

    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      shadow.adoptedStyleSheets = [sheet];
    }

    borderEl = document.createElementNS(HTML_NS, 'div');
    borderEl.setAttribute('class', 'cc-frame');

    boxEl = document.createElementNS(HTML_NS, 'div');
    boxEl.setAttribute('class', 'cc-box');

    rippleEl = document.createElementNS(HTML_NS, 'div');
    rippleEl.setAttribute('class', 'cc-ripple');

    cursorEl = document.createElementNS(HTML_NS, 'div');
    cursorEl.setAttribute('class', 'cc-cursor');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 2L20 11L12.5 13.2L9.5 21L3 2Z');
    path.setAttribute('fill', '#06b6d4');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    cursorEl.appendChild(svg);

    pillEl = document.createElementNS(HTML_NS, 'div');
    pillEl.setAttribute('class', 'cc-pill');
    pillDotEl = document.createElementNS(HTML_NS, 'span');
    pillDotEl.setAttribute('class', 'cc-dot');
    pillTextEl = document.createElementNS(HTML_NS, 'span');
    pillEl.appendChild(pillDotEl);
    pillEl.appendChild(pillTextEl);

    shadow.appendChild(borderEl);
    shadow.appendChild(boxEl);
    shadow.appendChild(rippleEl);
    shadow.appendChild(cursorEl);
    shadow.appendChild(pillEl);
    root.appendChild(host);
    return true;
  }

  function reducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function move(x, y, options) {
    if (!ensureMounted()) return { arrived: true, skipped: true };
    const opts = options || {};
    const skipAnim = reducedMotion() || document.visibilityState !== 'visible' || opts.style === 'snap';
    const duration = skipAnim ? 0 : Math.min(Math.max(Number(opts.durationMs) || 220, 0), 420);

    cursorEl.style.transition = duration > 0
      ? 'transform ' + duration + 'ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease'
      : 'none';
    cursorEl.style.opacity = '1';
    cursorEl.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';

    if (opts.targetBox && typeof opts.targetBox.width === 'number') {
      boxEl.style.left = opts.targetBox.x + 'px';
      boxEl.style.top = opts.targetBox.y + 'px';
      boxEl.style.width = opts.targetBox.width + 'px';
      boxEl.style.height = opts.targetBox.height + 'px';
      boxEl.style.opacity = '1';
      if (boxTimer) clearTimeout(boxTimer);
      boxTimer = setTimeout(() => {
        if (boxEl) boxEl.style.opacity = '0';
      }, duration + 160);
    }

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (cursorEl) cursorEl.style.opacity = '0.2';
    }, 2000);

    return { arrived: true, skipped: skipAnim };
  }

  function ripple(x, y) {
    if (!ensureMounted()) return;
    if (reducedMotion() || document.visibilityState !== 'visible') return;
    if (rippleTimer) clearTimeout(rippleTimer);
    rippleEl.style.transition = 'none';
    rippleEl.style.opacity = '0.95';
    rippleEl.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0) scale(0.35)';
    void rippleEl.offsetWidth;
    rippleEl.style.transition = 'transform 260ms ease-out, opacity 260ms ease-out';
    rippleEl.style.opacity = '0';
    rippleEl.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0) scale(1.65)';
    rippleTimer = setTimeout(() => {
      if (rippleEl) rippleEl.style.opacity = '0';
    }, 280);
  }

  function setControlState(state, label, takeoverMessage) {
    if (state === 'idle') {
      destroy();
      return;
    }
    if (!ensureMounted()) return;
    borderEl.setAttribute('class', 'cc-frame ' + state);
    pillEl.setAttribute('class', 'cc-pill visible ' + state);
    pillTextEl.textContent = state === 'takeover'
      ? (takeoverMessage || label || 'Needs your input')
      : (label || 'Controlling page');
  }

  function setHidden(hidden) {
    if (!host) return;
    host.style.display = hidden ? 'none' : '';
  }

  function destroy() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (boxTimer) { clearTimeout(boxTimer); boxTimer = null; }
    if (rippleTimer) { clearTimeout(rippleTimer); rippleTimer = null; }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }
    host = null;
    shadow = null;
    cursorEl = null;
    boxEl = null;
    rippleEl = null;
    pillEl = null;
    pillDotEl = null;
    pillTextEl = null;
    borderEl = null;
  }

  globalThis.__ccHahaCursor = { move, ripple, setControlState, setHidden, destroy };
})();`
}

export interface InPageCursorControllerOptions {
  transport: CdpTransport
  sessionId?: string
  noOverlay?: boolean
}

export class InPageCursorController {
  private readonly transport: CdpTransport
  private readonly sessionId?: string
  private noOverlay: boolean
  private executionContextId: number | null = null
  private docScriptIdentifier: string | null = null
  private installedFrameId: string | null = null

  constructor(options: InPageCursorControllerOptions) {
    this.transport = options.transport
    this.sessionId = options.sessionId
    this.noOverlay = options.noOverlay === true
  }

  isDisabled(): boolean {
    return this.noOverlay
  }

  setNoOverlay(noOverlay: boolean): void {
    const next = noOverlay === true
    if (next === this.noOverlay) {
      return
    }
    this.noOverlay = next
    if (next) {
      void this.forceTeardown()
    }
  }

  invalidateContext(): void {
    this.executionContextId = null
    this.installedFrameId = null
  }

  private isContextInvalidError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /cannot find context|execution context|no such execution context|context was destroyed/i.test(
      msg,
    )
  }

  private async evaluateInIsolatedWorld<T = unknown>(
    frameId: string,
    expression: string,
    timeoutMs: number,
  ): Promise<{ value?: T } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ready = await this.ensureInstalled(frameId)
      if (!ready || this.executionContextId === null) {
        return null
      }
      try {
        const res = await this.transport.send<{
          result?: { value?: T }
          exceptionDetails?: { text?: string }
        }>(
          'Runtime.evaluate',
          {
            contextId: this.executionContextId,
            expression,
            returnByValue: true,
          },
          { sessionId: this.sessionId, timeoutMs },
        )
        if (
          res.exceptionDetails &&
          attempt === 0 &&
          this.isContextInvalidError(res.exceptionDetails.text ?? '')
        ) {
          this.invalidateContext()
          continue
        }
        return { value: res.result?.value }
      } catch (err) {
        if (attempt === 0 && this.isContextInvalidError(err)) {
          this.invalidateContext()
          continue
        }
        return null
      }
    }
    return null
  }

  async ensureInstalled(frameId: string): Promise<boolean> {
    if (this.noOverlay) {
      return false
    }
    if (this.executionContextId !== null && this.installedFrameId === frameId) {
      return true
    }

    const script = buildInPageCursorBootstrapScript()

    if (!this.docScriptIdentifier) {
      try {
        const added = await this.transport.send<{ identifier?: string }>(
          'Page.addScriptToEvaluateOnNewDocument',
          {
            source: script,
            worldName: IN_PAGE_CURSOR_WORLD_NAME,
          },
          { sessionId: this.sessionId, timeoutMs: 3_000 },
        )
        if (typeof added.identifier === 'string') {
          this.docScriptIdentifier = added.identifier
        }
      } catch {
        // Non-fatal if browser doesn't support worldName
      }
    }

    try {
      const world = await this.transport.send<{ executionContextId?: number }>(
        'Page.createIsolatedWorld',
        {
          frameId,
          worldName: IN_PAGE_CURSOR_WORLD_NAME,
          grantUniveralAccess: false,
        },
        { sessionId: this.sessionId, timeoutMs: 3_000 },
      )
      if (typeof world.executionContextId !== 'number') {
        return false
      }
      this.executionContextId = world.executionContextId
      this.installedFrameId = frameId

      await this.transport.send(
        'Runtime.evaluate',
        {
          contextId: this.executionContextId,
          expression: script,
          returnByValue: true,
        },
        { sessionId: this.sessionId, timeoutMs: 3_000 },
      )
      return true
    } catch {
      this.executionContextId = null
      this.installedFrameId = null
      return false
    }
  }

  async moveCursor(
    frameId: string,
    payload: BrowserCursorPayload,
  ): Promise<{ arrived: boolean; skipped?: boolean }> {
    if (this.noOverlay) {
      return { arrived: true, skipped: true }
    }
    const expr = `globalThis.__ccHahaCursor?.move(${JSON.stringify(payload.x)}, ${JSON.stringify(payload.y)}, ${JSON.stringify({
      durationMs: payload.durationMs,
      style: payload.style,
      targetBox: payload.targetBox,
    })})`
    const res = await this.evaluateInIsolatedWorld<{
      arrived?: boolean
      skipped?: boolean
    }>(frameId, expr, 500)
    if (!res) {
      return { arrived: true, skipped: true }
    }
    return {
      arrived: res.value?.arrived ?? true,
      skipped: res.value?.skipped ?? false,
    }
  }

  async clickRipple(
    frameId: string,
    payload: BrowserCursorPayload,
  ): Promise<void> {
    if (this.noOverlay) {
      return
    }
    await this.evaluateInIsolatedWorld(
      frameId,
      `globalThis.__ccHahaCursor?.ripple(${JSON.stringify(payload.x)}, ${JSON.stringify(payload.y)})`,
      300,
    )
  }

  async setControlState(
    frameId: string,
    payload: BrowserControlStatePayload,
  ): Promise<void> {
    if (this.noOverlay) {
      return
    }
    if (payload.state === 'idle') {
      await this.teardown()
      return
    }
    await this.evaluateInIsolatedWorld(
      frameId,
      `globalThis.__ccHahaCursor?.setControlState(${JSON.stringify(payload.state)}, ${JSON.stringify(payload.label ?? '')}, ${JSON.stringify(payload.takeoverMessage ?? '')})`,
      300,
    )
  }

  async setHidden(hidden: boolean): Promise<void> {
    if (this.noOverlay || this.executionContextId === null) {
      return
    }
    try {
      await this.transport.send(
        'Runtime.evaluate',
        {
          contextId: this.executionContextId,
          expression: `globalThis.__ccHahaCursor?.setHidden(${hidden ? 'true' : 'false'})`,
          returnByValue: true,
        },
        { sessionId: this.sessionId, timeoutMs: 120 },
      )
    } catch (err) {
      if (this.isContextInvalidError(err)) {
        this.invalidateContext()
      }
      // Best-effort hide/show around screenshots
    }
  }

  /**
   * Tears down the in-page Closed Shadow DOM cursor within a hard 150ms bound.
   */
  async teardown(): Promise<void> {
    if (this.noOverlay) {
      return
    }
    await this.forceTeardown()
  }

  private async forceTeardown(): Promise<void> {
    const contextId = this.executionContextId
    const scriptId = this.docScriptIdentifier
    this.executionContextId = null
    this.installedFrameId = null
    this.docScriptIdentifier = null

    if (contextId === null && !scriptId) {
      return
    }

    const work = (async () => {
      if (contextId !== null) {
        try {
          await this.transport.send(
            'Runtime.evaluate',
            {
              contextId,
              expression: 'globalThis.__ccHahaCursor?.destroy()',
              returnByValue: true,
            },
            { sessionId: this.sessionId, timeoutMs: TEARDOWN_TIMEOUT_MS },
          )
        } catch {
          // Ignore teardown errors on closed/navigated tabs
        }
      }
      if (scriptId) {
        try {
          await this.transport.send(
            'Page.removeScriptToEvaluateOnNewDocument',
            { identifier: scriptId },
            { sessionId: this.sessionId, timeoutMs: TEARDOWN_TIMEOUT_MS },
          )
        } catch {
          // Ignore
        }
      }
    })()

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS)
    })

    await Promise.race([work, timeout])
    if (timer) {
      clearTimeout(timer)
    }
  }
}
