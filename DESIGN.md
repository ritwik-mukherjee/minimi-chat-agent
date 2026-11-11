# DESIGN.md

**What it is.** A chat agent on Node and TypeScript with one tool, Claude's server-side web search. It saves every turn with its local date, answer and cited sources, and when a message points at an earlier day ("last Tuesday", "3 November") code finds that day's turns and the model re-checks them against today's sources. One runtime dependency (`@anthropic-ai/sdk`), `node:sqlite`, `node:http`, a plain HTML page, no build step.

## How a turn works

`handleTurn` in `src/turn.ts` reads top to bottom as these five steps. Only step 4 calls a model.

```text
1. UNDERSTAND (code)  date parser: "last Tuesday" -> 2026-11-03, using one clock and the browser's time zone
2. RECALL     (code)  SQLite: the date selects turns, topic words only rank them; near miss within 3 days
3. ROUTE      (code)  from the recall result: compare (8 searches) | ordinary / no_record (5) | code-written reply
4. ANSWER     (model) one streamed Sonnet 5.5 call, tools: [web search], recalled turns passed in as context
5. SAVE       (code)  answer, sources, model, timings; a pending row is written first, so a crash leaves a trace
```

## Why it is built this way

*   **Gets things right.** Dates are resolved by tested code, never by the model, and every reply states the date it used. A day with saved turns can never come back as "no record", because wording does not filter turns. When nothing is saved the agent says so; it never describes a conversation that is not on file. A message with no subject ("What did I ask you on 3 November?") and nothing saved is answered by code with no model call at all. Each re-checked item gets one of four verdicts, and "could not verify" is never reported as "unchanged".
*   **Answers fast.** No call of any kind runs before the answer call. The recalled record and each search query reach the page as events while the model works, so the user sees progress at once. Measured on this machine (median of 3, real API, `npm run measure`, 2026-11-11):

| Case | Model | First event | First text | Total | Searches |
| --- | --- | --- | --- | --- | --- |
| Ordinary: Neon free tier | claude-sonnet-5-5 | 1 ms | 6.2 s | 6.2 s | 1 |
| Ordinary: Supabase Pro price | claude-sonnet-5-5 | 0 ms | 5.7 s | 5.8 s | 1 |
| No search: thanks | claude-sonnet-5-5 | 0 ms | 0.9 s | 1.7 s | 0 |
| Recall: earlier today (after the Neon turn) | claude-sonnet-5-5 | 2 ms | 8.6 s | 10.5 s | 1 |

    On search turns the API sends the answer text in one burst at the end (Stage 0: first search at 0.9 s, all text within 1 ms at 5.9 s), so total time and time to first status event are the honest numbers, not time to first token. "First event" is the recalled or routed event; the first search query follows at about 1 s.
*   **Good to talk to.** The status line says what the agent is doing ("Found your question from Tuesday 3 November", "Searching: Supabase pricing"), driven only by server events. Memory is visible in one sitting: "earlier today" takes the same path as "last Tuesday", and a saved-turns view lists everything stored.
*   **Cost.** Sonnet 5.5 is $2 per million input tokens and $10 per million output tokens; search is $10 per 1,000. The cap is 5 searches per turn, or 8 on a then-versus-now turn, so search costs at most $0.08 a turn. Earlier search results are never sent back.

## Considered and rejected

| Option | Why not |
| --- | --- |
| Memory as a model tool | The brief says one tool. It also adds a round trip before the record can be shown. Recall runs in code first. |
| Vector search | "On 3 November" names a day; similarity cannot answer that exactly. It needs an embedding model and another key. |
| Claim extraction after every answer | Doubles model calls while few turns are ever recalled. The whole answer plus its citations is stored instead. |
| A classifier for routing | One extra round trip every turn. The route follows from the recall result, so there is nothing left to classify. |
| Opus for comparisons | Measured in Stage 0 at the same effort: 12.2 to 17.9 s to first text against Sonnet's 7.0 to 11.3 s, 1.6 to 1.75 times slower, with no better verdicts on three recall tests. `MODEL_COMPARE` can switch it back. |
| Dynamic filtering search | The API runs model-written code, which can look like a second tool. Direct search keeps "one tool" true. |
| Seeded history or a date control | Fake history contradicts "never describe a conversation that did not happen"; a fake clock does not move the web back. |

## Known limits

*   An undated reference that shares no words with the saved turn is missed; the saved-turns view lists everything.
*   A near miss can match on one weak shared word (for example "pricing"), and the model then has to say the saved turn is unrelated.
*   Answers on search turns appear all at once, because the API sends the text in one burst.

## With another week

Extract claims on first recall for per-claim verdicts and a history of checks; a JSON import of dated history; background re-checks that say when an answer changed; score a classifier against the date rules on labelled messages before adding one; try filtering search if search-heavy turns prove slow; let a follow-up recall a second date mid-answer.
