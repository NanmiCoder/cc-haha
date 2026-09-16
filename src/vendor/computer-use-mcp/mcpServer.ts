/**
 * MCP server factory + session-context binder.
 *
 * Two entry points:
 *
 *   `bindSessionContext` — the wrapper closure. Takes a `ComputerUseSessionContext`
 *   (getters + callbacks backed by host session state), returns a dispatcher.
 *   Reusable by both the MCP CallTool handler here AND Cowork's
 *   `InternalServerDefinition.handleToolCall` (which doesn't go through MCP).
 *   This replaces the duplicated wrapper closures in apps/desktop/…/serverDef.ts
 *   and the Claude Code CLI's CU host wrapper — both did the same thing: build `ComputerUseOverrides`
 *   fresh from getters, call `handleToolCall`, stash screenshot, merge permissions.
 *
 *   `createComputerUseMcpServer` — the Server object. When `context` is provided,
 *   the CallTool handler is real (uses `bindSessionContext`). When not, it's the
 *   legacy stub that returns a not-wired error. The tool-schema ListTools handler
 *   is the same either way.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ScreenshotResult } from "./executor.js";
import type { CuCallToolResult } from "./toolCalls.js";
import { NATIVE_ERROR } from './nativeError.js'
import {
  APP_INVENTORY,
  NATIVE_CALL_NOT_DISPATCHED,
  defersLockAcquire,
  handleToolCall,
  resetMouseButtonHeld,
  RESOLVED_APP_PATH,
  staticRequestError,
} from "./toolCalls.js";
import { buildComputerUseTools } from "./tools.js";
import {
  defersLockAcquire as legacyDefersLockAcquire,
  handleToolCall as legacyHandleToolCall,
  hasHeldMouseForSession,
  releaseHeldMouseForSession,
  resetMouseButtonHeld as legacyResetMouseButtonHeld,
  WINDOWS_MOUSE_OWNER,
  type WindowsMouseOwner,
} from "./windowsLegacyToolCalls.js";
import { buildComputerUseTools as buildLegacyComputerUseTools } from "./windowsLegacyTools.js";
import type {
  AppGrant,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  ComputerUseSessionContext,
  CoordinateMode,
  CuGrantFlags,
  CuPermissionResponse,
} from "./types.js";
import { DEFAULT_GRANT_FLAGS } from "./types.js";
import { REPL_MAX_CODE_BYTES, type ComputerUseReplRuntime } from './replProtocol.js'

const DEFAULT_LOCK_HELD_MESSAGE =
  "Another Claude session is currently using the computer. Wait for that " +
  "session to finish, or find a non-computer-use approach.";

/**
 * Dedupe `granted` into `existing` on bundleId, spread truthy-only flags over
 * defaults+existing. Truthy-only: a subsequent `request_access` that doesn't
 * request clipboard can't revoke an earlier clipboard grant — revocation lives
 * in a Settings page, not here.
 *
 * Same merge both hosts implemented independently today.
 */
function mergePermissionResponse(
  existing: readonly AppGrant[],
  existingFlags: CuGrantFlags,
  response: CuPermissionResponse,
): { apps: AppGrant[]; flags: CuGrantFlags } {
  const seen = new Set(existing.map((a) => a.bundleId));
  const apps = [
    ...existing,
    ...response.granted.filter((g) => !seen.has(g.bundleId)),
  ];
  const truthyFlags = Object.fromEntries(
    Object.entries(response.flags).filter(([, v]) => v === true),
  );
  const flags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...existingFlags,
    ...truthyFlags,
  };
  return { apps, flags };
}

/**
 * Build the tool face this platform can actually service.
 *
 * Exported because the CLI host assembles the advertised tool list and the
 * `allowedTools` allowlist in two other places. Those must not re-derive the
 * choice themselves: advertising the semantic tools while dispatch runs the
 * legacy pixel handler produces two disjoint name sets, and every model call
 * lands on "Unknown computer-use tool".
 */
export function buildPlatformComputerUseTools(
  caps: {
    screenshotFiltering: "native" | "none";
    platform: "darwin" | "win32";
    teachMode?: boolean;
  },
  coordinateMode: CoordinateMode,
  installedAppNames?: string[],
): Tool[] {
  return caps.platform === "win32"
    ? buildLegacyComputerUseTools(caps, coordinateMode, installedAppNames)
    : buildComputerUseTools(caps, coordinateMode, installedAppNames)
      .filter(tool => tool.name === 'js' || tool.name === 'js_reset');
}

/**
 * Bind session state to a reusable dispatcher. The returned function is the
 * wrapper closure: async lock gate → build overrides fresh → `handleToolCall`
 * → stash screenshot → strip piggybacked fields.
 *
 * The last-screenshot blob is held in a closure cell here (not on `ctx`), so
 * hosts don't need to guarantee `ctx` object identity across calls — they just
 * need to hold onto the returned dispatcher. Cowork caches per
 * `InternalServerContext` in a WeakMap; the CLI host constructs once at server creation.
 */
export function bindSessionContext(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  ctx: ComputerUseSessionContext,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<CuCallToolResult> {
  const { logger, serverName } = adapter;

  // Screenshot blob persists here across calls — NOT on `ctx`. Hosts hold
  // onto the returned dispatcher; that's the identity that matters.
  let lastScreenshot: ScreenshotResult | undefined;
  let repl: ComputerUseReplRuntime | undefined
  let replEpoch = 0
  const replError = (text: string): CuCallToolResult => ({ isError: true, content: [{ type: 'text', text }] })

  const wrapPermission = ctx.onPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onPermissionRequest!(req, signal);
        const { apps, flags } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        logger.debug(
          `[${serverName}] permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        ctx.onAllowedAppsChanged?.(apps, flags);
        return response;
      }
    : undefined;

  const wrapTeachPermission = ctx.onTeachPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onTeachPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onTeachPermissionRequest!(req, signal);
        logger.debug(
          `[${serverName}] teach permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        // Teach doesn't request grant flags — preserve existing.
        const { apps } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        ctx.onAllowedAppsChanged?.(apps, {
          ...DEFAULT_GRANT_FLAGS,
          ...ctx.getGrantFlags(),
        });
        return response;
      }
    : undefined;

  // Which tool face this session speaks. macOS drives the semantic AX engine;
  // Windows has no AX tree to address, so it keeps the legacy pixel face.
  // Everything below — dispatch, lock deferral, stale-mouse cleanup — has to
  // come from the SAME module, or a Windows session would defer the lock by
  // the semantic face's rules while dispatching through the pixel one.
  const legacyPixelFace = adapter.executor.capabilities.platform === "win32";
  const dispatchToolCall = legacyPixelFace
    ? legacyHandleToolCall
    : handleToolCall;
  const toolDefersLockAcquire = legacyPixelFace
    ? legacyDefersLockAcquire
    : defersLockAcquire;
  const clearStaleMouseState = legacyPixelFace
    ? legacyResetMouseButtonHeld
    : resetMouseButtonHeld;
  const mouseOwner: WindowsMouseOwner = {
    canRelease: async () => !ctx.checkCuLock || (await ctx.checkCuLock()).isSelf,
  }

  const cancellationResult = async (
    message: string,
    beforeDispatch: boolean,
    checkedLock?: { holder: string | undefined; isSelf: boolean },
  ): Promise<CuCallToolResult> => {
    let cleanupMessage = ''
    if (legacyPixelFace && hasHeldMouseForSession(mouseOwner)) {
      try {
        const released = checkedLock && !checkedLock.isSelf
          ? false
          : await releaseHeldMouseForSession(adapter, mouseOwner)
        if (!released && hasHeldMouseForSession(mouseOwner)) {
          cleanupMessage = ' Held mouse cleanup was skipped because this session no longer owns the Computer Use lock.'
        }
      } catch (error) {
        cleanupMessage = ` Could not release this session's held mouse: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return {
      isError: true,
      content: [{ type: 'text', text: message + cleanupMessage }],
      ...(beforeDispatch ? { [NATIVE_CALL_NOT_DISPATCHED]: true } : {}),
    }
  }

  const dispatch = async (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CuCallToolResult> => {
    const isAborted = () => signal?.aborted === true || ctx.isAborted?.() === true;
    if (isAborted()) {
      return cancellationResult('Computer Use cancelled before dispatch.', true)
    }
    // ─── Static request validation (semantic face only) ───────────────────
    // Runs before the lock so a malformed call costs nothing: no cross-process
    // lock acquisition, no TCC probe, no approval dialog. The legacy face
    // validates inside its own dispatch and has no equivalent pure stage.
    if (!legacyPixelFace && !adapter.isDisabled()) {
      const invalid = staticRequestError(
        name,
        args,
        ctx.getGrantFlags(),
        adapter.executor.capabilities.platform,
      );
      if (invalid) return invalid;
    }

    // ─── Async lock gate ─────────────────────────────────────────────────
    // Replaces the sync Gate-3 in `handleToolCall` — we pass
    // `checkCuLock: undefined` below so it no-ops. Hosts with
    // cross-process locks (O_EXCL file) await the real primitive here
    // instead of pre-computing + feeding a fake sync result.
    if (ctx.checkCuLock) {
      const lock = await ctx.checkCuLock();
      if (isAborted()) {
        return cancellationResult('Computer Use cancelled before lock acquisition.', true, lock)
      }
      if (lock.holder !== undefined && !lock.isSelf) {
        const text =
          ctx.formatLockHeldMessage?.(lock.holder) ?? DEFAULT_LOCK_HELD_MESSAGE;
        return {
          content: [{ type: "text", text }],
          isError: true,
          telemetry: { error_kind: "cu_lock_held" },
          [NATIVE_CALL_NOT_DISPATCHED]: true,
        };
      }
      if (lock.holder === undefined && !toolDefersLockAcquire(name)) {
        await ctx.acquireCuLock?.();
        // Re-check: the awaits above yield the microtask queue, so another
        // session's check+acquire can interleave with ours. Hosts where
        // acquire is a no-op when already held (Cowork's CuLockManager) give
        // no signal that we lost — verify we're now the holder before
        // proceeding. The CLI's O_EXCL file lock would surface this as a throw from
        // acquire instead; this re-check is a belt-and-suspenders for that
        // path too.
        const recheck = await ctx.checkCuLock();
        if (isAborted()) {
          return cancellationResult('Computer Use cancelled before dispatch.', true, recheck)
        }
        if (recheck.holder !== undefined && !recheck.isSelf) {
          const text =
            ctx.formatLockHeldMessage?.(recheck.holder) ??
            DEFAULT_LOCK_HELD_MESSAGE;
          return {
            content: [{ type: "text", text }],
            isError: true,
            telemetry: { error_kind: "cu_lock_held" },
            [NATIVE_CALL_NOT_DISPATCHED]: true,
          };
        }
        // Fresh holder → any prior session's mouseButtonHeld is stale.
        // Mirrors what Gate-3 does on the acquire branch. After the
        // re-check so we only clear module state when we actually won.
        clearStaleMouseState();
      }
    }

    // ─── Build overrides fresh ───────────────────────────────────────────
    // Blob-first; dims-fallback with base64:"" when the closure cell is
    // unset (cross-respawn). scaleCoord reads dims; pixelCompare sees "" →
    // isEmpty → skip.
    const dimsFallback = lastScreenshot
      ? undefined
      : ctx.getLastScreenshotDims?.();

    // Per-call AbortController for dialog dismissal. Aborted in `finally` —
    // if handleToolCall finishes (MCP timeout, throw) before the user
    // answers, the host's dialog handler sees the abort and tears down.
    const dialogAbort = new AbortController();

    const overrides: ComputerUseOverrides = {
      allowedApps: [...ctx.getAllowedApps()],
      grantFlags: ctx.getGrantFlags(),
      userDeniedBundleIds: ctx.getUserDeniedBundleIds(),
      coordinateMode,
      selectedDisplayId: ctx.getSelectedDisplayId(),
      displayPinnedByModel: ctx.getDisplayPinnedByModel?.(),
      displayResolvedForApps: ctx.getDisplayResolvedForApps?.(),
      lastScreenshot:
        lastScreenshot ??
        (dimsFallback ? { ...dimsFallback, base64: "" } : undefined),
      onPermissionRequest: wrapPermission
        ? (req) => wrapPermission(req, dialogAbort.signal)
        : undefined,
      onTeachPermissionRequest: wrapTeachPermission
        ? (req) => wrapTeachPermission(req, dialogAbort.signal)
        : undefined,
      onAppsHidden: ctx.onAppsHidden,
      getClipboardStash: ctx.getClipboardStash,
      onClipboardStashChanged: ctx.onClipboardStashChanged,
      onResolvedDisplayUpdated: ctx.onResolvedDisplayUpdated,
      onDisplayPinned: ctx.onDisplayPinned,
      onDisplayResolvedForApps: ctx.onDisplayResolvedForApps,
      onTeachModeActivated: ctx.onTeachModeActivated,
      onTeachStep: ctx.onTeachStep,
      onTeachWorking: ctx.onTeachWorking,
      getTeachModeActive: ctx.getTeachModeActive,
      // Undefined → handleToolCall's sync Gate-3 no-ops. The async gate
      // above already ran.
      checkCuLock: undefined,
      acquireCuLock: undefined,
      isAborted,
      ...(legacyPixelFace ? { [WINDOWS_MOUSE_OWNER]: mouseOwner } : {}),
    };

    logger.debug(
      `[${serverName}] tool=${name} allowedApps=${overrides.allowedApps.length} coordMode=${coordinateMode}`,
    );

    // ─── Dispatch ────────────────────────────────────────────────────────
    try {
      const result = await dispatchToolCall(adapter, name, args, overrides);

      if (result.screenshot) {
        lastScreenshot = result.screenshot;
        const { base64: _blob, ...dims } = result.screenshot;
        logger.debug(`[${serverName}] screenshot dims: ${JSON.stringify(dims)}`);
        ctx.onScreenshotCaptured?.(dims);
      }

      if (legacyPixelFace && isAborted()) {
        // An in-flight mouse-down may have completed after cancellation. Its
        // press belongs to this binder, but the action did already dispatch.
        const cancelled = await cancellationResult('Computer Use cancelled after dispatch. Inspect the current state before continuing.', false)
        return { ...result, ...cancelled, content: [...result.content, ...cancelled.content] }
      }

      return result;
    } finally {
      dialogAbort.abort();
    }
  };
  // A daemon serializes single commands, not whole sequences. Keep every
  // semantic call behind one session queue so ordinary tools cannot interleave.
  let tail: Promise<unknown> = Promise.resolve();
  return (name, args, signal) => {
    if (legacyPixelFace) {
      return dispatch(name, args, signal);
    }
    if (name === 'js_reset') {
      if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 0) {
        return Promise.resolve(replError('js_reset takes an empty object.'))
      }
      ++replEpoch
      return (async () => {
        await repl?.reset()
        return { content: [{ type: 'text' as const, text: 'Computer Use JavaScript reset. Select an app again to continue.' }] }
      })()
    }
    const epoch = replEpoch
    const pending = tail.then(async () => {
      if (name !== 'js') return dispatch(name, args, signal)
      if (epoch !== replEpoch) return replError('Computer Use JavaScript was reset before this queued cell started.')
      if (adapter.isDisabled() || signal?.aborted || ctx.isAborted?.()) {
        await repl?.reset()
        return replError('Computer Use JavaScript is disabled or cancelled.')
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return replError('js requires an object with code.')
      const input = args as Record<string, unknown>
      const timeoutMs = input.timeout_ms ?? 30000
      if (typeof input.code !== 'string' || Buffer.byteLength(input.code) > REPL_MAX_CODE_BYTES ||
        Object.keys(input).some(key => !['code', 'title', 'timeout_ms'].includes(key)) ||
        (input.title !== undefined && typeof input.title !== 'string') ||
        typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        return replError('js requires code (up to 256 KiB), an optional title, and timeout_ms between 1 and 60000.')
      }
      if (!adapter.createReplRuntime) return replError('This Computer Use host does not provide an isolated JavaScript kernel.')
      repl ??= adapter.createReplRuntime()
      return repl.run({ code: input.code, timeoutMs, signal, isAborted: () => adapter.isDisabled() || ctx.isAborted?.() === true },
        async (method, parameters, innerSignal) => {
          // Inner operations use the existing guarded dispatcher directly;
          // re-entering the outer session queue would deadlock the cell.
          const result = await dispatch(method, parameters, innerSignal)
          return {
            ...result,
            ...(result[RESOLVED_APP_PATH] === undefined ? {} : { app: result[RESOLVED_APP_PATH] }),
            ...(result[APP_INVENTORY] === undefined ? {} : { apps: result[APP_INVENTORY] }),
            ...(result[NATIVE_ERROR] === undefined ? {} : { nativeError: result[NATIVE_ERROR] }),
            ...(result[NATIVE_CALL_NOT_DISPATCHED] === true ? { nativeCallNotDispatched: true } : {}),
          }
        })
    });
    tail = pending.catch(() => {});
    return pending;
  };
}

export function createComputerUseMcpServer(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context?: ComputerUseSessionContext,
): Server {
  const { serverName, logger } = adapter;

  const server = new Server(
    { name: serverName, version: "0.1.3" },
    // NO server `instructions` here, deliberately. Server instructions are
    // spliced into the system prompt for as long as the server is connected,
    // which would put Computer Use workflow guidance in front of every user —
    // including the ones who deliberately turned the feature off. The guidance
    // lives in the `computer-use` skill instead, which is registered only when
    // the setting is on and loaded only when actually invoked.
    { capabilities: { tools: {}, logging: {} } },
  );

  const tools = buildPlatformComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  );

  if (context) {
    const dispatch = bindSessionContext(adapter, coordinateMode, context);
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        const { screenshot: _s, telemetry: _t, ...result } = await dispatch(
          request.params.name,
          request.params.arguments ?? {},
          extra.signal,
        );
        return result;
      },
    );
    return server;
  }

  // Legacy: no context → stub handler. Reached only if something calls the
  // server over MCP transport WITHOUT going through a binder (a wiring
  // regression). Clear error instead of silent failure.
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      logger.warn(
        `[${serverName}] tool call "${request.params.name}" reached the stub handler — no session context bound. Per-session state unavailable.`,
      );
      return {
        content: [
          {
            type: "text",
            text: "This computer-use server instance is not wired to a session. Per-session app permissions are not available on this code path.",
          },
        ],
        isError: true,
      };
    },
  );

  return server;
}
