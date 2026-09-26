// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { Message } from "../../pi-ai";
import { buildSections } from "./build-sections";
import { clip } from "./content";
import { normalize } from "./normalize";
import { renderMessage } from "./render-entries";
import { searchEntries } from "./search-entries";
import { type CompileInput, compile } from "./summarize";
import { estimateTokensFromChars } from "./token-estimate";

const SECTION_HEADERS = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context"];

interface RoleCounts {
  user: number;
  assistant: number;
  toolResult: number;
}

interface BlockCounts {
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
}

export interface RecallProbe {
  label: string;
  sourceText: string;
  query: string;
  summaryMentioned: boolean;
  recallHits: number;
}

export interface CompactReport {
  summary: string;
  before: {
    messageCount: number;
    roleCounts: RoleCounts;
    blockCounts: BlockCounts;
    inputChars: number;
    estimatedTokens: number;
    topFiles: string[];
    preview: string;
  };
  after: {
    summaryLength: number;
    estimatedTokens: number;
    sectionCount: number;
    summaryPreview: string;
    goalsCount: number;
    blockersCount: number;
    briefTranscriptLines: number;
  };
  compression: {
    charsBefore: number;
    charsAfter: number;
    ratio: number;
    messagesBefore: number;
  };
  recall: {
    probes: RecallProbe[];
  };
}

const countRoles = (messages: Message[]): RoleCounts => {
  const counts: RoleCounts = { user: 0, assistant: 0, toolResult: 0 };
  for (const msg of messages) {
    if (msg.role === "user") counts.user += 1;
    else if (msg.role === "assistant") counts.assistant += 1;
    else if (msg.role === "toolResult") counts.toolResult += 1;
  }
  return counts;
};

const countBlocks = (messages: Message[]): BlockCounts => {
  const counts: BlockCounts = {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
  };

  for (const block of normalize(messages)) {
    if (block.kind === "user") counts.user += 1;
    else if (block.kind === "assistant") counts.assistant += 1;
    else if (block.kind === "tool_call") counts.toolCalls += 1;
    else if (block.kind === "tool_result") counts.toolResults += 1;
  }

  return counts;
};

const inputCharsOf = (messages: Message[]): number =>
  messages
    .map((msg, index) => renderMessage(msg, index, true).summary.length)
    .reduce((sum, len) => sum + len, 0);

const topFilesOf = (messages: Message[]): string[] => {
  const files = new Set<string>();
  for (const block of normalize(messages)) {
    if (block.kind === "tool_call") {
      for (const key of ["path", "file_path", "filePath", "file"]) {
        const val = block.args[key];
        if (typeof val === "string") { files.add(val); break; }
      }
    }
  }
  return [...files].slice(0, 10);
};

const previewOf = (messages: Message[], edgeCount = 3): string => {
  const rendered = messages.map((msg, index) => renderMessage(msg, index));
  if (rendered.length === 0) return "(empty)";
  if (rendered.length <= edgeCount * 2) {
    return rendered
      .map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`)
      .join("\n");
  }

  const first = rendered.slice(0, edgeCount);
  const last = rendered.slice(-edgeCount);
  return [
    ...first.map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`),
    "...",
    ...last.map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`),
  ].join("\n");
};

const sectionCountOf = (summary: string): number =>
  SECTION_HEADERS.filter((header) => summary.includes(`[${header}]`)).length;

const briefLineCountOf = (summary: string): number => {
  const sep = "\n\n---\n\n";
  const idx = summary.indexOf(sep);
  if (idx < 0) return 0;
  return summary.slice(idx + sep.length).split("\n").length;
};

const queryTermsOf = (text: string): string[] =>
  (text.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])
    .map((part) => part.trim())
    .filter(Boolean);

const queryOf = (text: string): string => {
  const terms = queryTermsOf(text);
  return terms.slice(0, 6).join(" ");
};

const matchesQuery = (text: string, query: string): boolean => {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
};

const probesOf = (messages: Message[], summary: string): RecallProbe[] => {
  const blocks = normalize(messages);
  const data = buildSections({ blocks });

  // Find first file from tool calls
  let firstFile = "";
  for (const b of blocks) {
    if (b.kind === "tool_call") {
      for (const key of ["path", "file_path", "filePath", "file"]) {
        if (typeof b.args[key] === "string") { firstFile = b.args[key] as string; break; }
      }
      if (firstFile) break;
    }
  }

  const rawProbes = [
    { label: "goal", text: data.sessionGoal[0] ?? "" },
    { label: "file", text: firstFile },
    { label: "problem", text: data.outstandingContext[0] ?? "" },
  ];

  const rendered = messages.map((msg, index) => renderMessage(msg, index));

  return rawProbes
    .map(({ label, text }) => {
      const sourceText = text.trim();
      const query = queryOf(sourceText);
      if (!query) return null;
      return {
        label,
        sourceText,
        query,
        summaryMentioned: matchesQuery(summary, query),
        recallHits: searchEntries(rendered, messages, query).length,
      };
    })
    .filter((probe): probe is RecallProbe => probe !== null);
};

export const buildCompactReport = (input: CompileInput): CompactReport => {
  const summary = compile(input);
  const data = buildSections({ blocks: normalize(input.messages) });
  const inputChars = inputCharsOf(input.messages);
  const topFiles = topFilesOf(input.messages);

  return {
    summary,
    before: {
      messageCount: input.messages.length,
      roleCounts: countRoles(input.messages),
      blockCounts: countBlocks(input.messages),
      inputChars,
      estimatedTokens: estimateTokensFromChars(inputChars),
      topFiles,
      preview: previewOf(input.messages),
    },
    after: {
      summaryLength: summary.length,
      estimatedTokens: estimateTokensFromChars(summary.length),
      sectionCount: sectionCountOf(summary),
      summaryPreview: summary,
      goalsCount: data.sessionGoal.length,
      blockersCount: data.outstandingContext.length,
      briefTranscriptLines: briefLineCountOf(summary),
    },
    compression: {
      charsBefore: inputChars,
      charsAfter: summary.length,
      ratio: summary.length === 0 ? 0 : Number((inputChars / summary.length).toFixed(2)),
      messagesBefore: input.messages.length,
    },
    recall: {
      probes: probesOf(input.messages, summary),
    },
  };
};
