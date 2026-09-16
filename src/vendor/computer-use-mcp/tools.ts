/**
 * MCP schemas for CC-haha's macOS native semantic API and batch sequence:
 *
 *   list_apps, get_app_state, click, perform_secondary_action, set_value,
 *   select_text, scroll, drag, press_key, type_text, paste, sequence
 *
 * This replaces the prior 27-tool pixel face. The legacy `coordinateMode` /
 * `screenshotFiltering` parameters are accepted for call-site compatibility
 * but no longer influence the semantic action schemas. Platform selection
 * controls sequence availability; Windows keeps its separate pixel tool API.
 *
 * The original names came from a historical third-party reconstruction, not
 * the current official Codex source. The current official interface uses a
 * persistent JavaScript entry point; these MCP tools are our compatibility API.
 *
 * Three things here are load-bearing and easy to erode:
 *
 *  • **`app` is required on every targeted tool.** There is no "omit to target
 *    the frontmost app" convenience: a missing target used to fall back to
 *    whatever was in front, which on a miss means driving the host's own
 *    window. Only `list_apps` — which targets nothing — omits it.
 *
 *  • **`element_index` is an opaque STRING handle** (`g17:4`), minted by the
 *    daemon and only meaningful inside the snapshot that produced it. It is
 *    not a line number and not an integer: a bare number is rejected rather
 *    than guessed at, because a stale integer silently addresses whatever now
 *    sits at that position.
 *
 *  • **Coordinates are in the latest `get_app_state` screenshot's pixel
 *    space**, not global screen space. The screenshot is window-locked, so
 *    global coordinates would land somewhere else entirely.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { CoordinateMode } from "./types.js";

/** App name / bundle id / pid string. Required on every targeted tool. */
const APP_PROP = {
  type: "string",
  description:
    "Target application: a display name (e.g. \"Finder\"), a bundle identifier " +
    "(e.g. \"com.apple.finder\"), an application path, or a numeric process id. " +
    "Required — there is no frontmost-app fallback.",
} as const;

/**
 * The opaque snapshot handle. Callers copy it verbatim from get_app_state;
 * they never construct, parse, or increment one.
 */
const ELEMENT_INDEX_PROP = {
  type: "string",
  description:
    "Opaque handle for the target element, copied verbatim from the most " +
    "recent get_app_state tree (e.g. \"g17:4\"). Handles are only valid within " +
    "the snapshot that produced them — re-read the state rather than reusing " +
    "an old handle or inventing one.",
} as const;

const MOUSE_BUTTON_PROP = {
  type: "string",
  enum: ["left", "middle", "right", "back", "forward", "l", "m", "r"],
  description:
    "Mouse button to use. Defaults to \"left\". \"right\" opens the context menu. " +
    "Single-letter aliases (\"l\", \"m\", \"r\") are accepted.",
} as const;

/**
 * A coordinate in the latest app-state screenshot's pixel space. Pixel space —
 * not global screen space — because the screenshot is locked to the target
 * window; a global coordinate would be off by the window's origin.
 */
function coordinateProp(axis: "x" | "y", role: string) {
  return {
    type: "number",
    minimum: 0,
    description:
      `The ${axis} coordinate of ${role}, in pixel coordinates within the ` +
      "latest get_app_state screenshot (its top-left corner is 0,0).",
  } as const;
}

/**
 * Build the native semantic tools and optional macOS batch tool.
 *
 * Signature is preserved from the legacy pixel builder so existing call sites
 * (`setup.ts`, host `mcpServer.ts`) keep compiling. Only the platform capability
 * affects this tool list; coordinate mode and installed-app hints are ignored.
 */
export function buildComputerUseTools(
  _caps?: {
    screenshotFiltering?: "native" | "none";
    platform?: "darwin" | "win32";
    teachMode?: boolean;
  },
  _coordinateMode?: CoordinateMode,
  _installedAppNames?: string[],
): Tool[] {
  const tools: Tool[] = [
    {
      name: 'js',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description: 'Run JavaScript in a persistent, isolated Computer Use session. Use this for native app automation: let app = await cua.getApp("App Name"); then await app.click([x,y]), app.drag([x,y],[x,y]), app.pressKey("CMD+A"), or loops of known actions. App selection emits initial state and API guidance. Observe with app.getAXState(), app.getScreenshot(), or app.getAXStateAndScreenshot(); emit:false returns data without displaying it. Use nodeRepl.write(value) for text and await nodeRepl.emitImage(bytes) for images. Top-level variables persist between calls, including after ordinary script errors. Await all actions. Imports, Node APIs, filesystem and networking are unavailable. Timeout/cancellation resets bindings; observe before retrying partial work. Native apps only; browser DOM/tab APIs are not implemented.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string', description: 'JavaScript with top-level await. Up to 256 KiB and 256 native calls per cell.' },
          title: { type: 'string', description: 'Short description of the operation.' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, default: 30000 },
        },
      },
    },
    {
      name: 'js_reset',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Reset the persistent Computer Use JavaScript session and discard all App handles and variables. Select an app again before continuing.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: "list_apps",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'List running and recently used applications, with running apps first. ' +
        "Each line is \"<App Name> — <bundle.id>\". Discovery does not grant access. Use this to discover " +
        "the exact app name or bundle id to pass to get_app_state.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },

    {
      name: "get_app_state",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Read the accessibility (AX) state of an application: an indented tree " +
        "of every interactive UI element, each tagged with the opaque handle to " +
        "pass as `element_index`, plus a screenshot of the app's key window. " +
        "Call this first, then after one or more standalone actions before deciding what to do next. " +
        "A sequence already returns its final state and screenshot; do not repeat an observation that is current.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          disableDiff: {
            type: "boolean",
            description:
              "Return the complete tree instead of a diff against the previous " +
              "snapshot of this app. Defaults to false. Pass true when you no " +
              "longer have that previous tree in view — a diff is unreadable " +
              "without the baseline it was computed from.",
          },
          disable_diff: {
            type: "boolean",
            description:
              "Compatibility alias for `disableDiff`. Pass only one of the two.",
          },
        },
        required: ["app"],
      },
    },

    {
      name: "click",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Click a UI element by `element_index` (the AX engine targets the " +
        "element directly, no pixel hunting), or at an explicit (x, y) point " +
        "read off the screenshot. Provide element_index OR both x and y. " +
        "Prefer element_index WHEN the element you want is actually in the " +
        "tree. Many apps — anything built on Chromium/Electron — expose only " +
        "their window frame and menu bar, and get_app_state says so; in that " +
        "case element handles cannot reach the content and (x, y) from the " +
        "screenshot is the only thing that works. Defaults to a single left " +
        "click. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          element_index: ELEMENT_INDEX_PROP,
          x: coordinateProp("x", "the point to click"),
          y: coordinateProp("y", "the point to click"),
          click_count: {
            type: "integer",
            minimum: 1,
            maximum: 3,
            description: "Number of clicks (2 = double-click, 3 = triple-click). Defaults to 1.",
          },
          mouse_button: MOUSE_BUTTON_PROP,
        },
        // NO root-level `anyOf` here, deliberately.
        //
        // "element_index OR (x, y)" is a natural fit for
        // `anyOf: [{required:["element_index"]}, {required:["x","y"]}]`, and that
        // is valid JSON Schema — a branch carrying only `required` constrains
        // objects. But some providers validate tool schemas more strictly than
        // the spec: Grok rejects the whole tool with
        //   "tool parameter root must be an object type
        //    (root schema is an anyOf/oneOf union with a non-object branch)"
        // because those branches do not spell out `type: "object"`. That kills
        // every Computer Use call on that provider while others accept it, so
        // the union is not worth its portability cost.
        //
        // Nothing is lost: the same rule is enforced at call time and fails
        // closed — see `click requires element_index, or both x and y` in
        // toolCalls.ts. The schema documents the shape; the runtime is the gate.
        required: ["app"],
      },
    },

    {
      name: "perform_secondary_action",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Perform a named secondary action on an element — the actions listed " +
        "after \"Secondary Actions:\" on that element's line in get_app_state " +
        "(e.g. \"Expand\", \"Collapse\", \"Raise\", \"Scroll Up\"). Pass the " +
        "action name exactly as shown. Call get_app_state afterwards to see " +
        "the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          element_index: ELEMENT_INDEX_PROP,
          action: {
            type: "string",
            description:
              "The secondary action name, exactly as printed after \"Secondary Actions:\" " +
              "in get_app_state.",
          },
        },
        required: ["app", "element_index", "action"],
      },
    },

    {
      name: "set_value",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Set the value of a settable element (text field, search field, slider) " +
        "by `element_index`. Only elements marked \"(settable, …)\" in " +
        "get_app_state can be set. This replaces the element's contents " +
        "directly — use type_text to append, or to type into whatever currently " +
        "has focus. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          element_index: ELEMENT_INDEX_PROP,
          value: {
            type: "string",
            description: "The value to assign to the element.",
          },
        },
        required: ["app", "element_index", "value"],
      },
    },

    {
      name: "select_text",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Select a run of text inside a text element (by `element_index`), or " +
        "place the text cursor before or after it. Provide `text` exactly as it " +
        "appears in get_app_state, including any Markdown formatting. If that " +
        "text is not unique within the element, add the immediately-surrounding " +
        "`prefix` and/or `suffix` to disambiguate the occurrence. Call " +
        "get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          element_index: ELEMENT_INDEX_PROP,
          text: {
            type: "string",
            description: "Target text exactly as shown in get_app_state.",
          },
          prefix: {
            type: "string",
            description:
              "Optional text immediately before the target, used to disambiguate repeated matches.",
          },
          suffix: {
            type: "string",
            description:
              "Optional text immediately after the target, used to disambiguate repeated matches.",
          },
          selection: {
            type: "string",
            enum: ["text", "cursor_before", "cursor_after"],
            description:
              "Whether to select the text or place the cursor before or after it. Defaults to \"text\".",
          },
          selection_type: {
            type: "string",
            enum: ["text", "cursor_before", "cursor_after"],
            description:
              "Compatibility alias for `selection`. Pass only one of the two.",
          },
        },
        required: ["app", "element_index", "text"],
      },
    },

    {
      name: "scroll",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Scroll an element (by `element_index`) or a point in a cardinal " +
        "direction. Target a scroll area or outline to reveal more rows. " +
        "`pages` is the number of pages to scroll (fractional allowed); " +
        "defaults to 1. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          element_index: ELEMENT_INDEX_PROP,
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right", "u", "d", "l", "r"],
            description:
              "Scroll direction. Single-letter aliases (\"u\", \"d\", \"l\", \"r\") are accepted.",
          },
          pages: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 10,
            description: "Number of pages to scroll. Fractional values allowed. Defaults to 1.",
          },
          x: coordinateProp("x", "the point to scroll at"),
          y: coordinateProp("y", "the point to scroll at"),
        },
        // No root-level `anyOf` — see the note on `click`. Enforced at call
        // time by `scroll requires element_index, or both x and y`.
        required: ["app", "direction"],
      },
    },

    {
      name: "drag",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Drag from one point to another (press, move, release) — for resizing " +
        "split panes, dragging scrollbars or sliders, and reordering. " +
        "Coordinate-only. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          from_x: coordinateProp("x", "the drag start point"),
          from_y: coordinateProp("y", "the drag start point"),
          to_x: coordinateProp("x", "the drag end point"),
          to_y: coordinateProp("y", "the drag end point"),
          from: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["x", "y"],
            description: "Compatibility alias for from_x/from_y.",
          },
          to: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["x", "y"],
            description: "Compatibility alias for to_x/to_y.",
          },
          mouse_button: MOUSE_BUTTON_PROP,
        },
        // No root-level `anyOf` — see the note on `click`. Enforced at call
        // time by parsePoint's `Expected from{x,y} or from_x/from_y`.
        required: ["app"],
      },
    },

    {
      name: "press_key",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Press a key or key combination, delivered to the target app. Uses " +
        "xdotool key names: modifiers \"super\"/\"ctrl\"/\"shift\"/\"alt\" joined " +
        "with \"+\" (e.g. \"super+c\" to copy, \"super+a\" to select all), and " +
        "named keys like \"Return\", \"Tab\", \"Escape\", \"BackSpace\", " +
        "\"Up\"/\"Down\"/\"Left\"/\"Right\", \"Prior\"/\"Next\" (page up/down), " +
        "\"Home\"/\"End\", \"F1\"–\"F12\", \"KP_0\"–\"KP_9\". \"super\" maps to " +
        "Command. Space-separated macros support at most 128 chords, executed in order. " +
        "Observe after the known action batch, using sequence or get_app_state.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          key: {
            type: "string",
            description: "Key or chord, e.g. \"Return\", \"super+c\", \"shift+Tab\".",
          },
        },
        required: ["app", "key"],
      },
    },

    {
      name: "type_text",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Type literal text into whatever currently has keyboard focus in the " +
        "target app. Appends to the focused field's contents. For keyboard " +
        "shortcuts use press_key; to replace a specific field's contents by " +
        "handle use set_value. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          text: {
            type: "string",
            description: "The literal text to type.",
          },
        },
        required: ["app", "text"],
      },
    },

    {
      name: "paste",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Paste content into whatever currently has keyboard focus in the target " +
        "app. Prefer this when type_text did not change a Chromium/CEF field, for " +
        "Chinese text, formatted content, or multiline text. The user's previous " +
        "clipboard is restored unless they copy something during the operation. " +
        "A timeout after Command-V is result-unknown: call get_app_state before " +
        "deciding whether to retry. Call get_app_state afterwards to see the result.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          app: APP_PROP,
          text: {
            type: "string",
            description: "The content to paste.",
          },
          format: {
            type: "string",
            enum: ["text", "md", "html"],
            description: "Pasteboard representation to use.",
          },
        },
        required: ["app", "text", "format"],
      },
    },
  ];
  if (_caps?.platform === "win32") {
    return tools.filter(tool => !['js', 'js_reset'].includes(tool.name));
  }
  const variants = tools
    .filter(tool => !["list_apps", "get_app_state", 'js', 'js_reset'].includes(tool.name))
    .map(tool => {
      const { app: _app, ...properties } = tool.inputSchema.properties ?? {};
      return {
        type: "object",
        additionalProperties: false,
        properties: { tool: { type: "string", const: tool.name }, ...properties },
        required: [
          "tool",
          ...(tool.inputSchema.required ?? []).filter(key => key !== "app"),
        ],
      };
    });
  tools.push({
    name: "sequence",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      "Run a bounded sequence of known UI actions in order against ONE app, then return its real AX state and screenshot. " +
      "Batch actions determined from the current observation, including repeated coordinates on a stable canvas, then inspect the final state. " +
      "Do not force one model round trip per click. If a step needs a new decision or changes the prerequisite state, stop and re-observe before continuing. " +
      "Each step uses tool plus that tool's arguments, without app. Stops on the first error or cancellation; never retries. " +
      "At most 256 steps, 128 space-separated chords per press_key step, 2048 total chords, and a 60-second cooperative deadline " +
      "(wait for the current native action to finish, then stop). " +
      "No nested sequences, code, sleeps or per-step app changes. A failed or timed-out step may have partially executed; inspect state before retrying.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        app: APP_PROP,
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: { anyOf: variants },
        },
      },
      required: ["app", "steps"],
    },
  });
  return tools;
}
