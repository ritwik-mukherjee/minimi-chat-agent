# Concepts Brief: Chat agent with web search and a dated memory ledger

Author: ritwik-mukherjee
Date: 2026-11-10

Requirements source: [challenge.md](../../challenge.md) (the only one).

## Reviewer status

| Lens | Reviewer | Status |
| --- | --- | --- |
| Architecture and design | `egm-design` | completed |
| Technical accuracy, library and API choice | `egm-codebase-details` | completed |
| Simplicity and scope | `egm-zoom-out` | completed |
| Naive reader and first-time user | `egm-comprehension` | completed |
| Implementation readiness | `egm-implementation-readiness` | completed |
| Structure and decomposition | `egm-structural` | completed |
| Contradictions and inventive transforms | `egm-inventive-catalyst` | completed |

No reviewer had web access. Every statement in this brief about the Anthropic API, the SDK, Node versions or a library comes from reviewer memory and is **unverified**. The items that matter are collected under "Facts to verify before writing code".

## Overview

The concept: a TypeScript chat agent on Node with one model tool (Claude's server-side web search, one API key), a SQLite ledger of dated questions, answers, claims and sources, date-based recall for questions about the past, a re-search-and-compare step, a plain "no record" reply when the ledger is empty, and a small character in the UI that shows agent state.

All seven reviewers support the core decisions: date lookup instead of vector similarity, refusing to invent a past conversation, and one key for model and search. All seven also reached the same main conclusion, independently:

1. **The concept is designed around the path judges are least likely to see.** On a fresh install all three example questions hit an empty ledger. The recall, claim and compare machinery then never runs, and the judge sees an ordinary search agent plus one sentence about having no record. The cold path and the ordinary search-and-answer path are the primary paths and are the least specified parts of the concept.
2. **Most of the proposed model steps are not needed.** Date resolution and ledger lookup are deterministic code. The search response already carries citations (URL, title, quoted source text) that can serve as the per-claim record. Comparison can happen inside the one streamed answer call. The result is one model call per turn instead of three or four.
3. **Memory must not be a model-callable tool.** The challenge says "It has one tool: web search." Recall has to run in code before the model call and be injected as context.

A calendar fact that affects design: 10 November 2026 is a Tuesday. Asked today, "3 November" and "last Tuesday" are the same day, and "Monday" is yesterday. Several records on one day with different topics is the expected case, not an edge case.

## Analysis

Findings are deduplicated across lenses. "Lenses" shows how many of the seven raised the point.

### Blockers

**B1. The cold-ledger path is treated as a fallback but is probably the first thing a judge sees.** (7 of 7)
"Says so plainly, then answers where possible" does not define the reply. The three examples need three different cold behaviours:
- CRM shortlist: the five tools are unknown. Guessing five would be invented history. State the miss with the resolved date, ask for the five names, and optionally report dated pricing and release changes for the category since that date, labelled as not being a comparison with the user's list.
- "What did I ask you on 3 November?": there is no underlying question to search. Say nothing is saved for that date, and say what is saved (earliest record date, or that this is the first conversation). Run no search.
- Postgres hosting: a search for dated pricing changes since the resolved date is useful without a baseline. Say there is no earlier answer to compare with.

Reply shape: one sentence of fact, no apology, the useful part, one specific request. Inject the absence into the prompt as an explicit fact ("no records on Mon 9 Nov 2026; history begins 10 Nov 2026"), which prevents invented memory more reliably than an instruction alone. Store the cold turn so the next ask has a baseline. "We shortlisted" may mean the user's team without the agent, so say "I don't have that shortlist saved", never "we did not discuss that". Do not use "ledger" or "record not found" in chat text.

**B2. The ordinary search-and-answer path is not designed.** (zoom-out, comprehension, design)
The task sentence is "as good as the best ones on the internet today", and the three examples are "a few examples from the dataset". Every question, including the memory ones, ends in an ordinary search turn. The concept says nothing about streaming, inline citations, when not to search, follow-ups within a conversation, a search cap, or a latency target. Design this path first and add memory to it.

**B3. A ledger lookup exposed to the model would be a second tool.** (7 of 7)
Recall must be code that runs before the model call and injects records as labelled data. The `tools` array holds web search only. The same rule excludes web fetch, code execution, and a tool definition used to force structured claim output. DESIGN.md needs one sentence: memory is context, not a tool. Trade-off to state: the model cannot do a second lookup mid-answer.

**B4. The decision "does this message refer to the past" has no mechanism.** (structural, readiness, design, zoom-out)
Reviewers agree it must not add a model round trip to ordinary turns. They disagree on the mechanism; see Alternatives Weighed, group 1. This has to be decided before building.

**B5. A judge cannot see memory work in one sitting, and default seeding would contradict the design's own honesty rule.** (7 of 7)
Agreed: never seed by default; ship with an empty ledger; make "earlier today" a valid date reference so the full path runs in one session; provide tests with a fake clock; document a clock override. A ledger view listing stored days, questions and sources was recommended by five lenses as the honest way to show memory exists. Disagreement on where the clock control lives and whether to offer opt-in sample history; see Alternatives Weighed, group 4.
A related defect: a simulated clock does not move the web back in time. A record made "last Tuesday" under a fake clock holds today's facts, so "what changed since" will report nothing. Store the real and simulated instants, mark such rows, and have the agent say so.

**B6. No defined behaviour when the judge's key cannot use web search, or the key is missing.** (codebase-details as Blocker; design, readiness, comprehension, catalyst as Major)
Web search may need enabling by an organisation admin (unverified). Check the key at startup and print one actionable line. Surface a search failure as a plain chat message naming what to enable. Never present an unsearched answer as checked. Make the model ID an env var with a default.

### Majors

**M1. Per-claim extraction costs more than it returns.** (design, codebase-details, zoom-out, catalyst, structural, readiness)
An extraction call per answer doubles model calls, is paid on every turn while few are recalled, can fail silently, and paraphrases what was said. The search response is reported to include citations tying answer spans to URL, title and quoted source text (unverified). Store the whole answer plus those citations at stream end. Caveats: cited spans are fragments that often lack a subject, and structured output may not combine with citations (unverified).

**M2. Recall plus re-search plus compare has no latency or cost bound.** (6 of 7)
Five tools times several claims can mean ten or more searches, 30 to 60 seconds, and over 100k input tokens on the judge's key (estimates, unverified). Agreed remedies: emit the recalled record immediately after the SQL read and before any model token; one streamed call with a search cap (`max_uses`, about 5 to 8); no separate compare call; forward search queries to the UI as they happen; no parallel fan-out by default because it can hit rate limits on a low-tier key; cap how many records are re-checked and say when the cap was hit; measure and publish time to first text per path.

**M3. Date-only lookup fails on ordinary imprecision.** (7 of 7)
Users misremember days, a day can hold several topics, and some references carry no date. Rule: the date narrows, the topic selects. Fetch records in the resolved range; if several, select by topic or list them all when no topic is named; if none, look at nearby days and say so ("Nothing about Postgres on Tuesday 3 November, but you asked on Wednesday 4 November. Using that."). Never substitute silently. Topic matching without vectors: keyword `LIKE`, or let the model pick from a short list of question titles.

**M4. Date resolution rules and time zones are unspecified.** (6 of 7)
Code does the date arithmetic; the model never does. Rules proposed: a bare weekday means the most recent such day strictly before today; a day and month with no year means the most recent occurrence not in the future; when "last Tuesday" has two readings, query both and prefer the one with a matching record. The browser sends its IANA zone; store the UTC instant, the zone and a precomputed `local_date`, and query on `local_date`. Always state the resolved date in the answer ("Tuesday 3 November") so a wrong reading is visible. Write the rules as a table-driven test against a fixed clock. The readiness reviewer supplied a 14-row table that can be used as the first test file.

**M5. A difference between then and now is not proof the world changed.** (design, comprehension, catalyst)
The earlier answer may have been wrong, or a different page was read. Use fixed verdicts: unchanged; changed, with a source dated after the original answer; differs from what I said, with no evidence of when; could not verify. "Could not verify" must never be reported as "unchanged". The stored quoted source text is what makes the third verdict possible. Search returns snippets and indexes can lag, so phrase results as "sources found today say".

**M6. The shape of a recall answer is undefined.** (comprehension)
Proposed order: one-line verdict; what was asked and when; per item, then and now with source and date; a "could not re-check" line with the reason.

**M7. The SQLite driver can break `npm install`.** (6 of 7; zoom-out rated it a Nit)
`better-sqlite3` is a native module and can fall back to compiling on a machine without a toolchain. Preferred: Node's built-in `node:sqlite` behind one small ledger module, with `engines`, `.nvmrc` and a startup version check (npm only warns on `engines`). Its stability status, the minimum Node version, and whether FTS5 is included are unverified. A JSONL file is the zero-dependency alternative. Test a clean clone on a second machine.

**M8. Two kinds of memory are not distinguished, and the single-user assumption is unstated.** (structural, zoom-out, readiness, comprehension, design, catalyst)
State: one user, one local file, no accounts; date recall searches the whole install, not one thread. Recent turns go into context as plain text for follow-ups; the ledger is consulted only on a past reference. Zoom-out proposes a single table of turns serving both purposes.

**M9. Server-side stream handling is unplanned.** (codebase-details, design, readiness)
Handle the `pause_turn` stop reason with a capped continuation loop (unverified), in-band search errors, 429 with retry-after, refusals, and `max_tokens`. Abort the upstream call when the browser disconnects. Do not replay old search result blocks in history: they are large, and partially stripped blocks may be rejected (unverified). Flatten prior turns to plain text.

**M10. The character's states have no defined signals, and it may work against the judging criteria.** (6 of 7)
Phase (recalling, searching, comparing) and confidence (unsure) are different things in one list. "Unsure" has no source unless tied to a measurable condition: recall miss, search error, zero results, or a "could not verify" verdict. Define one typed event union emitted by the pipeline; the UI renders from events and never parses prose. Every state carries a specific caption ("Looking up Tuesday 3 November", "Searching: Supabase pricing"). Build a text status line first and the character last, as a skin over the same events. It is the first thing to cut.

**M11. The pipeline, schema, error table and tests are not written down.** (readiness, structural)
A developer would have to guess the schema, the steps and model calls per path, the event protocol, and behaviour for each failure. Proposed: one `handleTurn` function of about 40 lines that reads top to bottom as the design diagram, with every other module a leaf; a turn row inserted as `pending` before the model call; an acceptance test per example question in both warm and cold cases (six cases) using a fake model and a fixed clock at Tuesday 2026-11-10.

**M12. What `npm run dev` runs is undecided.** (codebase-details, readiness, design)
One process, one port, prints the URL. Plain `node:http`, `fetch` POST with a hand-parsed event stream (`EventSource` is GET-only), static HTML and CSS with one browser module, no bundler. Escape web-derived text and allow only http(s) links.

**M13. DESIGN.md content the concept does not yet have.** (structural, comprehension, catalyst, zoom-out)
The page must state rejected alternatives with reasons, measured latency per path, and a next-week list. The memory story can crowd these out. Proposed outline: what it is (two sentences); one diagram of one request with three branches, each box marked code or model call; five numbered steps; why, tied to "fast", "right", "good to talk to"; rejected options table; known limits; another week. Setup goes in the README. Define "ledger", "claim" and "injectable clock" in one clause each.

**M14. No observability.** (codebase-details)
"Answers fast" cannot be argued without numbers. Record per turn: resolved date reading, records hit, time to recall event, time to first token, total time, search count, tokens, stop reason. Show it in a collapsible view.

**M15. No way to load dated history if the judges' dataset includes prior turns.** (catalyst)
A documented import path (JSON with timestamps) would cover this. It is a guess at what judges have; a plain documented POST chat endpoint is the minimum.

**M16. Distinctiveness is aimed at the wrong layer.** (zoom-out, catalyst)
Judges rank architecture. The distinctive decisions that match that criterion are date-keyed recall, refusal to invent a past, and then-versus-now answers backed by stored evidence. Lead DESIGN.md with those.

### Nits

- N1. Stored web text re-enters later prompts, a persistent prompt-injection route. Wrap recalled records in a delimited data block, cap snippet length, add a "clear memory" control. (design, codebase-details, readiness)
- N2. The clock must be the only source of time: one instance passed to the resolver, the ledger writer and the prompt builder. (structural, codebase-details)
- N3. Prompt caching needs a stable system prompt; put the date and recalled records in the user turn. Check usage figures before claiming a gain. (codebase-details, design)
- N4. Keep all SDK calls in one module so the vendor coupling is one file wide. (structural)
- N5. `.env.example`: `ANTHROPIC_API_KEY` required; optional `PORT`, model ID, DB path, default zone; a comment about enabling web search. (readiness)
- N6. Create the database on first run, git-ignore it, set a schema version. (readiness, design)
- N7. State the search cap and per-turn call count in DESIGN.md, since judges pay for searches. (readiness)
- N8. The three example dates sit in one calendar week; do not hard-code anything to it, and test the week-later case. (codebase-details)

### Contradictions and how reviewers proposed to remove them

| Contradiction | Resolution |
| --- | --- |
| Fast versus correct on recall | Show the recalled record at once from the local read; one capped streamed call does the re-search and comparison |
| Per-claim precision versus extraction cost | Use the citations already returned as the claim record; write after the stream ends |
| Memory needed versus memory absent | Make the miss useful: dated change evidence since the referenced day, one specific request, and the turn stored as a baseline |
| Verifiable in one sitting versus real elapsed time | Same-day references, a visible ledger view, fake-clock tests, an opt-in labelled clock override |
| One tool versus memory access | Recall in code before the model call; memory is context |
| Deterministic lookup versus loose human language | Code resolves to a candidate range; the topic and the ledger choose; the resolved date is always stated |
| Informative character versus distraction | The character is a pure rendering of pipeline events, each with a caption |
| Distinctive versus "not the prettiest screen" | Put the distinctiveness in the architecture and the inspectable ledger, not the screen |

### Facts to verify before writing code

One real API call each, in a throwaway script:
1. The web search tool's type string, and which model IDs support it.
2. The citation shape on answer text (URL, title, quoted text) and whether it can be stored as the claim record.
3. Whether structured output can be combined with search and citations.
4. The stream event sequence for a search, and where the query text becomes available.
5. `pause_turn` behaviour and how to continue.
6. The error when web search is not enabled for the organisation.
7. Whether prior assistant turns can be replayed as plain text without their search result blocks.
8. `node:sqlite`: minimum Node version, stability label, experimental warning, FTS5.
9. Node's built-in TypeScript running and `--env-file`, for the pinned version.
10. Time to first text for 1, 3 and 5 searches.

## Goals vs. Non-Goals

### Goals

- Answer ordinary questions with web search: streamed, cited inline, correct about today's date, with a search cap and a measured latency target.
- Handle follow-ups within a conversation; skip search for greetings and questions that need none.
- Record every turn with its timestamp, zone, local date, answer and cited sources, persisted across restarts.
- Resolve date references in code against one injected clock, in the user's time zone, and state the resolved date in every recall answer.
- On a past reference with records: show the recalled record immediately, then report then versus now with fixed verdicts and sources.
- On a past reference with no records: say so in one sentence, do the useful work that is possible without a baseline, ask for the one missing input, and store the turn.
- Expose exactly one model tool: web search.
- Let a judge confirm memory in one sitting without fabricated history.
- Run from `npm install` and `npm run dev` with one API key, one process, one port, with clear messages for a missing key or unavailable search.
- Fit the design on one page; keep one orchestration function a reader can map to the diagram.

### Non-Goals

- Vector search or embeddings.
- A memory tool, web fetch, code execution, or any second model tool.
- A separate claims table filled by an extraction call on every turn.
- A separate compare call or a diff component in code.
- Parallel fan-out per entity.
- Multiple users, accounts, or thread-scoped recall.
- History seeded by default.
- Background re-checking or change notifications.
- A UI framework or bundler.
- An agent framework.
- The character, until everything above is built and tested.

## Alternatives Weighed

### 1. Deciding whether a message refers to the past (open; reviewers disagree)

| Option | For | Against | Backed by |
| --- | --- | --- | --- |
| Deterministic detector and date parser only | No added latency; testable; easy to explain | Misses loose phrasing ("the other day", "that list we made") | structural, codebase-details |
| No router: detector runs on every turn, plus a small index of recent turns (date and question, about 30 rows) always in the prompt | No extra call; the index catches undated references; search stays the model's choice | A few hundred tokens per turn; false-positive lookups, harmless if labelled | design, zoom-out |
| Small-model router call returning JSON (recall, date expression, topic, standalone question), skipped by a cheap pre-check | Handles loose phrasing; produces the standalone question for the cold path | An extra round trip on some turns; a second failure point; needs a fallback | readiness |

Synthesis: the second option gets most of the router's benefit with no extra call and is consistent with the one-call-per-turn conclusion. Adopt it unless the Stage 0 spike shows the parser misses too many phrasings, in which case add the router behind the pre-check.

### 2. What to store per answer

| Option | For | Against |
| --- | --- | --- |
| A. Whole answer plus API citations (preferred by 5 lenses) | No extra call; exact record of what was said; quoted source text kept | Fragments, not self-contained claims; comparison relies on the model |
| B. A, plus structured claims extracted lazily on first recall and cached | Per-claim verdict rows and a history of checks; cost only on recall turns | One more call on recall turns; more schema |
| C. Eager extraction on every turn (the concept as stated) | Richest data model | Highest cost, most failure modes, value invisible in a cold test |
| A facts block emitted at the end of the same generation, parsed in code | Typed values without a second call | Can be malformed; needs a fallback to citations; speculative |

Synthesis: build A. Name B as the first "another week" item, or add it only after the base agent is fast and correct. Record C as considered and rejected.

### 3. Re-check and compare

- One streamed call with the old record injected and search capped (preferred by all who addressed it).
- Per-entity parallel calls then a synthesis: faster wall clock, more tokens, rate-limit risk, more code. Reject unless measurement requires it.
- Typed-value diff in code: only possible with structured claims. Defer with option B above.

### 4. Showing memory to a judge in one sitting (partly open)

| Option | Status |
| --- | --- |
| Same-day references through the same path | Agreed, build |
| Ledger view listing stored days, questions, sources | Agreed by 5 lenses, build |
| Tests with fake clock and fake model for the three examples, warm and cold | Agreed, build |
| Clock override by env var only, documented in README | catalyst, zoom-out, structural, codebase-details |
| Clock control in the UI ("Pretend today is"), labelled | readiness; catalyst argues against a UI control |
| Opt-in sample history via a command, rows labelled and disclosed by the agent | comprehension, structural, catalyst, design; zoom-out lists it as a non-goal; readiness would cut it first |
| History seeded by default | Rejected by all |
| JSON import of dated history | catalyst only; speculative |

Either clock option needs the simulated-time labelling described in B5.

### 5. Storage engine

- `node:sqlite` built in: no install step; needs a pinned recent Node; status unverified. Preferred.
- `better-sqlite3`: mature; native build risk on the judge's machine.
- `sql.js`: no native build; in-memory, manual persistence.
- JSONL file: zero dependencies; no indexed queries; reads as less of a design. Have an answer ready for "why SQLite at this size": date-range queries and atomic writes.

### 6. Other rejected options to record in DESIGN.md

Vector memory (date and keyword lookup is exact and needs no embedding key); a separate search API (second key, second failure mode, a client tool loop to write); an agent framework; model-computed dates; WebSocket transport; Vite and React.

## Key Decisions & Staging for Next Steps

### Decisions resolved (author adopted the reviewers' recommendations, 2026-11-10)

1. **Past-reference detection.** A deterministic detector and date parser run in code on every turn, plus a short index of recent turns (date and question) always in the prompt. No router call. Revisit only if the Stage 0 spike shows the parser misses too many phrasings.
2. **Claim storage.** Store the whole answer plus the citations the API returns. Eager per-claim extraction is rejected. Lazy extraction on first recall is the first "another week" item.
3. **Judge-facing verification.** Same-day references run the full recall path; a view lists stored days, questions and sources; tests use a fake clock and fake model. The clock override is an env var only, and rows written under a simulated clock are labelled. No UI clock control. No sample history, opt-in or otherwise.
4. **The character.** The pipeline emits typed events. A captioned status line is built first. The character is built last as a rendering of the same events. "Unsure" appears only on a recall miss, search error, zero results, or a "could not verify" verdict.
5. **Storage engine.** `node:sqlite` behind one ledger module with a pinned Node version, subject to Stage 0 verification. Fallback: a JSONL file.
6. **Cold CRM reply.** Reviewers split and gave no recommendation. Chosen: state that no shortlist is saved for the resolved date, ask for the five names, and add a short list of dated pricing and release changes for the category since that date, labelled as not being a comparison with the user's list. This keeps the reply useful without guessing the five tools. Open to change after trying it by hand.

### Staging

- **Stage 0, spike (about half a day, throwaway).** Resolve the ten items under "Facts to verify". Exit: measured time to first text; confirmed citation shape; confirmed storage choice.
- **Stage 1, pure core, no network.** Clock, date resolver with the rules table as tests, ledger module. Exit: tests pass offline.
- **Stage 2, ordinary path end to end.** Server, event stream, minimal page, streamed cited answers, follow-up context, search cap, error messages, turn stored. Exit: clean clone runs on a second machine with `npm install` and `npm run dev`.
- **Stage 3, recall.** Past-reference detection, hit, near miss, several-per-day selection, the three cold replies, fixed verdicts. Exit: six acceptance cases pass with fakes.
- **Stage 4, judge-facing proof.** Ledger view, clock override with labelling, per-turn timings, captioned status; the character if time allows. Exit: the three example questions run by hand, cold and warm, in one sitting.
- **Stage 5, write-up.** One-page DESIGN.md with measured numbers and the rejected list, README, `.env.example`, clean-clone rehearsal.

### Three strongest objections

1. **The architecture's main work sits on a path judges may never exercise.** Cold, all three examples take the no-record branch. That branch and a one-sitting way to see recall work need to be designed first.
2. **The ordinary search-and-answer turn is undesigned, and it decides every question.** If it is slow, uncited or wrong on a plain question, the ledger does not recover the judgement.
3. **The multi-step pipeline is slower, costlier and harder to explain than needed.** Code can recall, one streamed call can search and compare, and citations can be stored as received. A memory tool would also break the one-tool rule. This objection rests on unverified API facts, so Stage 0 comes before any design is fixed.
