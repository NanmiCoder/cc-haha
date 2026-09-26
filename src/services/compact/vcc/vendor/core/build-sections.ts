// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { FileOps, NormalizedBlock } from "../types";
import { clipSentence, nonEmptyLines } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital letter, code identifier, or quote
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }

  return items.slice(0, 5);
};

const formatFileActivity = (blocks: NormalizedBlock[], fileOps?: FileOps): string[] => {
  const act = extractFiles(blocks, fileOps);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  // ─── LOCAL EDIT (cc-haha) ─────────────────────────────────────────────────
  // Upstream capped every category at 10. Measured over 240 real scenarios, a
  // slice edits up to 28 files, and the cap alone accounted for 29 of the 42
  // changed-but-unnamed files -- the largest recoverable recall gap, and the
  // only one that costs a reader something, since `Read` entries merely say a
  // file was opened. Edits and writes get a cap that clears the observed range (28 files, so 36 leaves headroom);
  // reads keep the upstream cap, as listing everything glanced at would crowd
  // out what changed without telling the reader anything.
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 36)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 36)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks, input.fileOps),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
};
