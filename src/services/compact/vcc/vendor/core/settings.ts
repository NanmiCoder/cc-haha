// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface PiVccSettings {
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /**
   * Permission (not a guarantee) for pi-vcc's own continue after a successful
   * automatic compaction (threshold, or overflow after the assistant already
   * finished with stop). It avoids a UX cliff where the agent finishes a response,
   * immediately compacts, and then stops instead of continuing the task.
   *
   * false = never continue. true (default) = continue only on Pi versions that
   * still need the fallback: Pi >= PI_SELF_RESUME_VERSION resumes the run itself,
   * so pi-vcc stays silent there even when this is true (issue #22). A version
   * that cannot be parsed is treated as new Pi, i.e. no continue.
   * Overflow retry is still owned by pi-core via willRetry.
   */
  continueAfterThresholdCompact: boolean;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * Providers for which pi-vcc defers compaction entirely (issue #27), e.g.
   * providers that ship their own remote compaction via another extension.
   * Matched case-insensitively against ctx.model.provider (Pi's provider id —
   * check /model; Grok is "xai", not "grok"). Explicit /pi-vcc bypasses the
   * skip. Unknown/undefined model never skips.
   */
  skipForProviders: string[];
  /**
   * customType values whose custom_message entries are excluded from the
   * summarizer input. Opt-in (default []). Intended for per-turn boilerplate
   * injected by other extensions that is regenerated every turn.
   * Exact match on customType. Filtering happens right before summarization:
   * cut selection, token calibration, firstKeptEntryId and kept-user-turn
   * counting are all unaffected.
   */
  skipCustomTypes: string[];
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
  skipForProviders: [],
  skipCustomTypes: [],
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/** Coerce a config value to string[], failing closed to []. */
const coerceStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  // A blind spread would leak a malformed array value (e.g. a bare string,
  // where .includes becomes substring matching) into the provider check.
  merged.skipForProviders = coerceStringArray(parsed.skipForProviders);
  merged.skipCustomTypes = coerceStringArray(parsed.skipCustomTypes);
  return merged;
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
