# Engine judgement of partial-compaction summaries

Local engine `zxsv-ai` at http://127.0.0.1:8000. 8 cases sampled from the largest sessions, alternating the pivot direction.

The engine sees the same span the compactor did and is asked to report coverage,
unsupported statements and misdirection. It is a reading, not a measurement: the
deterministic numbers live in `vcc-slice-calibration.md`.

```
bun run scripts/vcc-slice-judge.ts --count 8
```

---
### 60aa321f-15e9-4b26-87e7-4d0d005a4094.jsonl — up_to@24071

- Slice: 41 messages (pivot-outward, <=60000 chars), 10733 chars rendered · Summary: 3422 chars · compression 31.9%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 3,
  "missing": [
    "The specific diagnostic logs added (e.g., 'Terminal:dbg' prefix) and their exact locations in handler.ts and terminalService.ts",
    "The verification that the diagnostic logging is working (probe output showing 'Terminal:dbg' logs)",
    "The current state of the dev server (running in background with ID b0k5e0ce9, log file /tmp/cc-haha-dev-7788.log)",
    "The next step: user needs to reproduce the issue on mobile to capture server-side evidence",
    "The investigation into the mobile layout issue (TabBar vs mobile-session-header, toggleBottomPanel behavior)"
  ],
  "falseClaims": [],
  "misleading": [
    "The summary lists 'Read' files but doesn't mention the Grep operations that were crucial for locating the terminal_exited path",
    "The summary doesn't indicate that the server was successfully restarted and verified working with the new logs"
  ],
  "readability": 3,
  "verdict": "needs-work"
}
```

### 3e0bcac3-4eac-45e7-817d-8e5319bcb3e2.jsonl — from@11359

- Slice: 72 messages (pivot-outward, <=60000 chars), 17839 chars rendered · Summary: 2608 chars · compression 14.6%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 3,
  "missing": [
    "The specific instrumentation logic added to model_runner.py (e.g., wrapping `sample()` and `speculator.propose()` with `self._prof.gpu_begin/end` and `cpu` calls) is not described, only that the file was modified.",
    "The baseline performance metrics are summarized as '73.4 tok/s', but the slice shows a median of 73.42 and mean of 73.29, with specific chunk gap stats (p50=23.2ms) that are useful for comparison.",
    "The engine restart command was executed in the background (ID: b8w882rum), but the summary does not explicitly state that the command is still running or where its output is being written, which is critical for the next step.",
    "The specific environment variables used for the profiler configuration (VLLM_DECODE_STEP_PROFILE_EVERY=10, VLLM_DECODE_STEP_PROFILE_WARMUP=20) are present in the command but not highlighted as key configuration parameters for the upcoming log parsing."
  ],
  "falseClaims": [],
  "misleading": [
    "The summary lists 'Read' for model_runner.py, but the slice shows multiple 'Edit' operations and a 'Read' operation to resolve ambiguity. The 'Read' was a diagnostic step, not the primary action, which might understate the complexity of the edits."
  ],
  "readability": 4,
  "verdict": "usable"
}
```

### 3791fdb8-bd0c-4fcd-ba65-331d72dd0fba.jsonl — up_to@11449

- Slice: 104 messages (pivot-outward, <=60000 chars), 25152 chars rendered · Summary: 4292 chars · compression 17.1%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 2,
  "missing": [
    "The initial diagnosis that port 8181 is a 'headroom proxy' (not litellm) and that it fails with 'No module named vllm' is completely omitted, despite being a major part of the investigation.",
    "The verification that vLLM direct connection on port 8000 works correctly for JSON tool calls (via curl tests) is missing, which was crucial for isolating the issue to the client-side configuration.",
    "The discovery that the opencode configuration actually uses the 'zxsv-ai' provider (port 8000) for most messages, not the 'HD-ZX' provider (port 8181), is missing. This contradicts the initial assumption that the proxy was the cause.",
    "The analysis of the session database showing that the 'empty output' messages had `error: null` and contained reasoning but no tool calls, proving it was a model behavior issue rather than a connection failure, is missing.",
    "The specific code locations identified for the fix: `bodyFields` in `openai-chat.ts` (L89-105) missing the field, and `lowerOptions` (L331-340) ignoring `chat_template_kwargs`."
  ],
  "falseClaims": [],
  "misleading": [
    "The summary lists 'Read: .config/opencode/opencode.jsonc' but omits the critical finding from that file: that there are two providers (HD-ZX on 8181 and zxsv-ai on 8000) and that the failing sessions were using the 8000 provider, not the proxy."
  ],
  "readability": 3,
  "verdict": "needs-work"
}
```

### 1c75db82-369d-4900-83a6-67be891b2b34.jsonl — from@1189

- Slice: 2 messages (pivot-outward, <=60000 chars), 63 chars rendered · Summary: 230 chars · compression 365.1%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 5,
  "missing": [],
  "falseClaims": [],
  "misleading": [],
  "readability": 5,
  "verdict": "usable"
}
```

### f999e38a-4574-4bf0-ba8d-07bc0686c7bb.jsonl — up_to@7512

- Slice: 104 messages (pivot-outward, <=60000 chars), 23443 chars rendered · Summary: 4379 chars · compression 18.7%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 3,
  "missing": [
    "The specific code changes made: renaming `maybePageGc` to `maybeTransientGc`, adding the call after the inspection snapshot cache set, and adding the call inside the per-file loop after `streamJsonlFile`.",
    "The final test result after adding per-file GC (the slice ends before the final measurement is shown, but the intent and the specific insertion point are critical).",
    "The specific threshold logic: GC only fires if `heapUsed > 512MB` (PAGE_GC_HEAP_THRESHOLD_MB), which explains why it didn't fire during the initial page read (116MB heap)."
  ],
  "falseClaims": [
    "The summary lists 'Read: sessionService.ts' as a separate item, but the slice shows multiple Reads and Edits; the summary's file list is too generic to be useful for a reader who needs to know *what* was read/changed."
  ],
  "misleading": [
    "The summary implies the work is complete or at a stable state by listing the final Edits, but the slice ends with the assistant still in the process of verifying the per-file GC insertion (the last action is an Edit, followed by a Read, then another Edit, with no final test result shown in the slice)."
  ],
  "readability": 4,
  "verdict": "usable"
}
```

### 5de884c1-a8db-46f9-ac31-94aa7aa7ffc1.jsonl — from@5222

- Slice: 55 messages (pivot-outward, <=60000 chars), 14931 chars rendered · Summary: 73 chars · compression 0.5%
- Sections: []
- Judge: ```json
{
  "coverage": 1,
  "missing": [
    "Dev service on port 7788 was restarted (old PID 903899 killed, new PID 957435 started at 16:25:44) and verified healthy with fresh dist.",
    "A deb build was running in the background (/tmp/deb-build3.log) and completed successfully (EXIT=0) before the restart.",
    "The user's specific feature requests: add execution time to subagents, total duration stats to the subagent collection bar, execution time to background tasks, and merge these into the 'think' duration optimization item.",
    "An Explore agent was launched and returned a detailed map of the current timing implementation in subagent and background task UIs.",
    "Environment variables for the dev service were preserved in /tmp/env7788.sh and a start script /tmp/start7788.sh was created."
  ],
  "falseClaims": [],
  "misleading": [
    "The summary ends with '先并行摸清现状' (first map the current state in parallel), implying the mapping phase is just starting, but the slice shows the mapping was completed via the Explore agent and the dev service restart was already finished."
  ],
  "readability": 2,
  "verdict": "needs-work"
}
```

### 353a69e2-17e0-4451-9747-edfb7364a3f9.jsonl — up_to@5096

- Slice: 43 messages (pivot-outward, <=60000 chars), 11032 chars rendered · Summary: 3544 chars · compression 32.1%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 4,
  "missing": [
    "The specific fix strategy identified: reusing the `backfillUsageSnapshot` pattern or calling `computeSessionUsageTree` to persist the snapshot after a full scan.",
    "The observation that the full-scan path and projector use the same algorithm (`computeSessionUsageTree` is a verbatim port of `computeSegmentInspectionSummary`), which is key to the proposed fix.",
    "The specific line numbers for the full-scan logic (3804+, 3874-3897) and the projector's `backfillUsageSnapshot` (line 853)."
  ],
  "falseClaims": [],
  "misleading": [
    "The summary lists 'Read: sessionService.ts, localIndex/sessionProjector.ts, localIndex/coordinator.ts' under 'Files And Changes', implying these files were modified or are the primary output, whereas the slice is primarily a diagnostic investigation involving Bash greps and Reads to confirm a root cause."
  ],
  "readability": 4,
  "verdict": "usable"
}
```

### 11faeccb-e719-4733-a4a1-f075d9736b1d.jsonl — from@5592

- Slice: 96 messages (pivot-outward, <=60000 chars), 21228 chars rendered · Summary: 4494 chars · compression 21.2%
- Sections: ["Files And Changes"]
- Judge: ```json
{
  "coverage": 3,
  "missing": [
    "The specific content of the local uncommitted change in `flash_decode_paged.cu` (E4M3 grouped verify relaxation to per-request q<=8) and the fact that it was verified to be absent from `origin/main` (old logic `q.size(0)==8` remained).",
    "The backup location and files created: `/home/zeaxion/myproject/1cat-vllm-v150/backup/` containing `local-ae75fb9-uncommitted.patch` and `flash_decode_paged.cu.local_modified`.",
    "The specific git operations performed to upgrade: `git stash push` for the .cu file, `git merge --ff-only origin/main`, and `git stash pop`.",
    "The decision to keep the version number as `1.5.0` using `SETUPTOOLS_SCM_PRETEND_VERSION=1.5.0` despite the code being from `7217bb5d4` (642 commits ahead of v1.5.0 tag).",
    "The background task ID `bwj1uut6i` and the specific output file path for monitoring the build."
  ],
  "falseClaims": [],
  "misleading": [
    "The summary lists `TaskCreate (#5597)` as a single item, but the slice shows three distinct tasks were created (#17, #18, #19) with specific subjects and descriptions.",
    "The summary omits the critical context that the 18 existing G28 patches in site-packages would be lost in the new wheel, which was the primary reason for the user question and the decision to 'only install clean mainline wheel'."
  ],
  "readability": 4,
  "verdict": "usable"
}
```
