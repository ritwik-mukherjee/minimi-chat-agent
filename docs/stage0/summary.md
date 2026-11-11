# Stage 0 results

Run on 2026-11-11 with Node v26.13.0, SDK 1.8.0,
models claude-sonnet-5-5 (default) and claude-opus-5-5 (compare).

## Results column for the Phase 0 table

| Item | Result |
| --- | --- |
| Q1 speed | Fallback: compare turns use claude-sonnet-5-5. Make the "Q1 speed fails" edits listed under the Phase 0 table. |
| Q1 effort | claude-sonnet-5-5: Pass: use effort low. Read results/q1effort/ to confirm the auto-grading. claude-opus-5-5: Pass: use effort low. Read results/q1effort/ to confirm the auto-grading. |
| Q2 Node | Pass: pin 26.13.0 in engines, .nvmrc and scripts/check-node.mjs. Ran on v26.13.0. The plan targets the newest Node 24 release; repeat `stage0.ts q2` under Node 24 (for example `nvm install 24 && nvm exec 24 node stage0.ts q2`) before pinning. |
| Q3a effort field | claude-sonnet-5-5: Pass: output_config.effort accepted with low, medium, high, xhigh, max. claude-opus-5-5: Pass: output_config.effort accepted with low, medium, high, xhigh, max. |
| Q3b thinking | claude-sonnet-5-5: Pass: send thinking {"type":"adaptive"} (chosen from the recorded tries; no new calls). claude-opus-5-5: Pass: send thinking {"type":"adaptive"} (chosen from the recorded tries; no new calls). |
| Q3c `max_tokens` | Pass: maxTokens compare 43008, default 32768. |
| Q3d `max_uses` on continuation | Fallback: pauseTurnLimit 1, repeat the original max_uses, and make the "Q3d fails" edits. |
| Q3e search disabled | Fallback: no key with web search turned off was given. Match status 400 plus "web search" (case-insensitive) in the message. |
| Q3f citations and counts | Fallback: count blocks for the cap during the stream, and save the usage figure as search_count. |
| Q3g SDK retries | Pass: maxRetries 0 sends one request; keep the single app-level 429 retry. |
| Fixtures | ordinary_two_searches.json saved (2 searches). search_error.json saved with a search error. pause_turn.json not produced: hand-write it from ordinary_two_searches.json with stop_reason pause_turn. |

## Values for the build

```ts
// src/config.ts
const MODEL_SETTINGS = {
  "claude-sonnet-5-5": { effort: "low", thinking: {"type":"adaptive"} },
  "claude-opus-5-5": { effort: "low", thinking: {"type":"adaptive"} },
};
const MAX_TOKENS = {"compare":43008,"default":32768};
```

*   Node to pin: v26.13.0 (see the Q2 note).
*   `@anthropic-ai/sdk` to pin: 1.8.0.
*   Fixtures to copy into `test/fixtures/`: `results/fixtures/*.json`.

## Spend so far

Searches: 113 (about $1.13). Token costs depend on current
model prices; the counts are below.

| Model | Calls | Input tokens | Output tokens |
| --- | --- | --- | --- |
| claude-sonnet-5-5 | 33 | 715001 | 69408 |
| claude-opus-5-5 | 28 | 699315 | 84202 |
