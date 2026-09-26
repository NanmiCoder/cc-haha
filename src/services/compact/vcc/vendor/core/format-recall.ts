// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { SearchHit, TouchedFile } from "./search-entries";

// ── Path shortening ───────────────────────────────────────────────────────

const CWD = process.cwd();

/**
 * Shorten an absolute file path for display:
 * - If within cwd, return `./relative/path`
 * - Otherwise, show last 3 path components with `.../` prefix
 * - Short paths (≤3 components) returned as-is
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function shortPath(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const cwdNormalized = CWD.replace(/\\/g, "/");
  if (normalized.startsWith(cwdNormalized + "/")) {
    return "." + normalized.slice(cwdNormalized.length);
  }
  const parts = normalized.split("/");
  if (parts.length > 3) {
    return ".../" + parts.slice(-3).join("/");
  }
  return normalized;
}

// ── Touched file output ───────────────────────────────────────────────────

export const TOUCHED_PAGE_SIZE = 5;

/**
 * Format aggregated "files touched" output.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function formatTouchedOutput(
  touched: TouchedFile[],
  page?: number,
  pageSize?: number,
): string {
  if (touched.length === 0) {
    return "No file operations found in session history.";
  }

  const ps = pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.ceil(touched.length / ps);
  const currentPage = Math.max(1, page ?? 1);
  const start = (currentPage - 1) * ps;
  const pageFiles = touched.slice(start, start + ps);

  const header =
    totalPages > 1
      ? `Page ${currentPage}/${totalPages} (${touched.length} total files)`
      : `${touched.length} files touched`;

  const lines = pageFiles.map((tf) => {
    const displayPath = shortPath(tf.path);
    const indices = tf.entries
      .map((e) => `#${e.index} (${e.toolName})`)
      .join(", ");
    return `  ${displayPath}    ${indices}`;
  });

  let result = `${header}:\n\n${lines.join("\n")}`;

  if (currentPage < totalPages) {
    result += `\n\n--- Use page:${currentPage + 1} for more results ---`;
  }

  return result;
}

export const formatRecallOutput = (
  entries: SearchHit[],
  query?: string,
  headerOverride?: string,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  const header = headerOverride
    ? `${headerOverride} for "${query}":`
    : query
      ? `Found ${entries.length} matches for "${query}":`
      : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    const body = query && e.snippet ? e.snippet : e.summary;
    return `#${e.index} [${e.role}]${fileSuffix} ${body}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
