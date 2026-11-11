// Stage 0 measurements for the minimi chat agent design
// (docs/designs/chat_agent_dated_memory_design.md, "Phase 0: Stage 0 measurements").
//
// Run one item at a time, in order:
//   node --env-file-if-exists=.env stage0.ts <item>
// Items: q2 q3a q3b q3c q1effort q1speed q3d q3e fixtures q3f q3g summary
// `node stage0.ts help` lists them with their rough cost. See README.md.
//
// This folder is not part of the repository. Only results/fixtures/*.json is
// copied into the repository (as test/fixtures/).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const HERE = import.meta.dirname;
const RESULTS = path.join(HERE, "results");
const DESIGN_DOC = process.env.DESIGN_DOC ||
  path.join(HERE, "..", "minimi application", "docs", "designs", "chat_agent_dated_memory_design.md");
const MODELS: Record<"default" | "compare", string> = {
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
  compare: process.env.MODEL_COMPARE || "claude-opus-5-5",
};
// The API's accepted values, lowest first (from its own validation error, 2026-11-11).
const EFFORT_LEVELS = (process.env.EFFORT_LEVELS || "low,medium,high,xhigh,max")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ZONE = "Europe/London";
const NOW = new Date();
const WEEK_AGO = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
const SEARCH_PRICE = 0.01; // dollars per search ($10 per 1,000)

const webSearch = (maxUses: number) => ({ type: "web_search_20250305", name: "web_search", max_uses: maxUses });

// ---------------------------------------------------------------------------
// Small helpers

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function writeJson(name: string, data: unknown, quiet = false): void {
  const file = path.join(RESULTS, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  if (!quiet) console.log(`  wrote results/${name}`);
}

function writeText(name: string, text: string): void {
  const file = path.join(RESULTS, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readJson(name: string): any {
  const file = path.join(RESULTS, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function need(name: string, item: string): any {
  return readJson(name) ?? fail(`results/${name} is missing. Run \`stage0.ts ${item}\` first.`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const unique = (xs: string[]) => [...new Set(xs)];
const safe = (s: string) => s.replace(/[^a-z0-9.-]+/gi, "_");

function dayLabel(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

function listWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

// ---------------------------------------------------------------------------
// SDK access. Loaded lazily so `q2` runs before `npm install`.

let AnthropicClass: any = null;

async function loadSdk(): Promise<any> {
  if (!AnthropicClass) {
    try {
      AnthropicClass = (await import("@anthropic-ai/sdk")).default;
    } catch {
      fail("The Anthropic SDK is not installed here. Run: npm install --save-exact @anthropic-ai/sdk");
    }
  }
  return AnthropicClass;
}

function sdkVersion(): string | null {
  const file = path.join(HERE, "node_modules", "@anthropic-ai", "sdk", "package.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).version : null;
}

async function client(options: Record<string, unknown> = {}): Promise<any> {
  const Anthropic = await loadSdk();
  if (!options.apiKey && !process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY is not set. Put it in .env next to this script.");
  }
  // SDK retries off, so every call in this script is exactly one request.
  return new Anthropic({ maxRetries: 0, ...options });
}

// Running totals across all items, kept in results/spend.json.
const spend: any = readJson("spend.json") ?? { searches: 0, byModel: {} };

function addSpend(model: string, usage: any): void {
  spend.searches += usage?.server_tool_use?.web_search_requests ?? 0;
  const m = (spend.byModel[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
  m.calls += 1;
  m.inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0);
  m.outputTokens += usage?.output_tokens ?? 0;
  writeJson("spend.json", spend, true);
}

type CallResult = { ok: boolean; message?: any; status?: number | null; type?: string | null; error?: string };

async function tryCreate(params: Record<string, unknown>, c?: any): Promise<CallResult> {
  const api = c ?? (await client());
  try {
    // Streamed even for small tests: SDK 1.8.0 refuses non-streamed requests
    // whose max_tokens is large ("Streaming is required ..."), before sending.
    const message = await api.messages.stream(params).finalMessage();
    addSpend(String(params.model), message.usage);
    return { ok: true, message };
  } catch (e: any) {
    return {
      ok: false,
      status: e?.status ?? null,
      type: e?.error?.error?.type ?? null,
      error: String(e?.error?.error?.message ?? e?.message ?? e),
    };
  }
}

const brief = (r: CallResult) => (r.ok
  ? { ok: true, stopReason: r.message.stop_reason }
  : { ok: false, status: r.status, type: r.type, error: r.error });

type Run = {
  events: unknown[]; message: any; firstTextMs: number | null; totalMs: number;
  searchBlocks: number; usageSearches: number | null;
};

async function stream(item: string, params: Record<string, unknown>): Promise<Run> {
  const api = await client();
  const started = performance.now();
  let firstTextMs: number | null = null;
  const events: unknown[] = [];
  const s = api.messages.stream(params);
  for await (const ev of s) {
    events.push(JSON.parse(JSON.stringify(ev)));
    if (firstTextMs === null && ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      firstTextMs = performance.now() - started;
    }
  }
  const message = await s.finalMessage();
  const totalMs = performance.now() - started;
  const searchBlocks = message.content
    .filter((b: any) => b.type === "server_tool_use" && b.name === "web_search").length;
  const usageSearches = message.usage?.server_tool_use?.web_search_requests ?? null;
  addSpend(String(params.model), message.usage);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.appendFileSync(path.join(RESULTS, "search_counts.jsonl"),
    JSON.stringify({ item, model: params.model, searchBlocks, usageSearches }) + "\n");
  return { events, message, firstTextMs, totalMs, searchBlocks, usageSearches };
}

const textOf = (message: any): string =>
  message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

// ---------------------------------------------------------------------------
// Prompt pieces, built the way Appendix A of the design doc describes.

function systemPrompt(): string {
  if (!fs.existsSync(DESIGN_DOC)) fail(`Design doc not found at ${DESIGN_DOC}. Set DESIGN_DOC.`);
  const doc = fs.readFileSync(DESIGN_DOC, "utf8");
  const heading = doc.indexOf("### System prompt (`SYSTEM_PROMPT`)");
  const open = doc.indexOf("```text\n", heading);
  const close = doc.indexOf("\n```", open + 8);
  if (heading < 0 || open < 0 || close < 0) fail("Could not find the system prompt in Appendix A of the design doc.");
  return doc.slice(open + 8, close).trim();
}

type Saved = { id: number; question: string; answer: string };

function savedBlock(saved: Saved[], date: Date): string {
  const label = dayLabel(date);
  const turns = saved.map((t) => [
    `<turn id="${t.id}" date="${label}">`,
    `<question>${t.question}</question>`,
    `<answer>${t.answer}</answer>`,
    "<sources>",
    "</sources>",
    "</turn>",
  ].join("\n")).join("\n");
  return `<saved_turns asked_for="${label}" near_miss="false" left_out="0">\n${turns}\n</saved_turns>`;
}

function userMessage(block: string | null, message: string): string {
  return [`Today is ${dayLabel(NOW)} (time zone ${ZONE}).`, block, message].filter(Boolean).join("\n\n");
}

// Three recall tests. Each saved answer contains one deliberately wrong price
// ($0.50), so "unchanged" is never the right verdict for that item.
const RECALL_TESTS = [
  {
    name: "postgres",
    outdated: "Supabase",
    others: ["Neon", "Railway"],
    question: "A week ago I asked you about Postgres hosting. Has any pricing changed since then?",
    saved: {
      id: 1,
      question: "Which managed Postgres hosts have a good free tier for a side project? Compare Neon, Supabase and Railway.",
      answer: "Neon has a free plan with autoscaling and branching, and paid plans for more compute and storage. " +
        "Supabase Pro costs $0.50 per month and includes a Postgres database, auth and storage. " +
        "Railway charges by usage, with a monthly subscription that includes some usage credit.",
    },
  },
  {
    name: "crm",
    outdated: "Pipedrive",
    others: ["HubSpot", "Zoho"],
    question: "A week ago we looked at CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    saved: {
      id: 2,
      question: "Which CRM should a 20-person sales team consider: HubSpot, Pipedrive or Zoho CRM?",
      answer: "HubSpot Sales Hub has a free tier and paid Starter, Professional and Enterprise plans. " +
        "Pipedrive's Essential plan costs $0.50 per user per month. " +
        "Zoho CRM has a free edition for a few users and paid Standard, Professional and Enterprise editions.",
    },
  },
  {
    name: "project",
    outdated: "Notion",
    others: ["Linear", "Asana"],
    question: "What did I ask you a week ago? Is your answer still correct today?",
    saved: {
      id: 3,
      question: "What do Linear, Asana and Notion cost for a small team?",
      answer: "Linear has a free plan and paid per-user plans. " +
        "Asana has a free Personal plan and paid Starter and Advanced plans. " +
        "Notion Plus costs $0.50 per seat per month.",
    },
  },
];

const ORDINARY_QUESTIONS = [
  "What does Neon's free tier include?",
  "What is the current price of Supabase Pro?",
  "Which is cheaper for a team of five today: Linear or Asana?",
];

const VERDICT = /(could not verify|differs|unchanged|changed)/i;

// Pass when every verdict given right after a mention of the outdated item is
// not "unchanged". The window stops at the next mention of another item, so a
// neighbour's verdict is not read by mistake. No verdict found counts as a fail
// that needs a human look.
function grade(text: string, item: string, others: string[]): { pass: boolean; verdict: string | null } {
  const lower = text.toLowerCase();
  const target = item.toLowerCase();
  let from = 0;
  let verdict: string | null = null;
  let pass = true;
  for (;;) {
    const i = lower.indexOf(target, from);
    if (i < 0) break;
    let end = Math.min(text.length, i + 400);
    for (const o of others) {
      const j = lower.indexOf(o.toLowerCase(), i + target.length);
      if (j >= 0 && j < end) end = j;
    }
    const m = text.slice(i, end).match(VERDICT);
    if (m) {
      verdict = m[1].toLowerCase();
      if (verdict === "unchanged") pass = false;
    }
    from = i + target.length;
  }
  if (verdict === null) pass = false;
  return { pass, verdict };
}

// Request settings found by earlier items.
function settingsFor(model: string, effortOverride?: string | null): Record<string, unknown> {
  const q3a = readJson("q3a.json");
  const q3b = readJson("q3b.json");
  const q1e = readJson("q1effort.json");
  const effort = effortOverride !== undefined ? effortOverride : (q1e?.[model]?.chosen ?? null);
  const out: Record<string, unknown> = {};
  if (effort && q3a?.[model]?.fieldAccepted) out.output_config = { effort };
  const thinking = q3b?.[model]?.chosen ?? null;
  if (thinking) out.thinking = thinking;
  return out;
}

function maxTokens(role: "default" | "compare"): number {
  return readJson("q3c.json")?.chosen?.[role] ?? (role === "compare" ? 16000 : 4096);
}

// ---------------------------------------------------------------------------
// Q2: Node checks. Local only, free.

function runNode(args: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

async function q2(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-stage0-q2-"));
  try {
    fs.writeFileSync(path.join(dir, "x.ts"),
      'const n: number = 1;\nconsole.log(process.env.STAGE0_ENV ?? "unset", n, typeof import.meta.filename);\n');
    const noEnvFile = runNode(["--env-file-if-exists=.env", "x.ts"], dir);
    fs.writeFileSync(path.join(dir, ".env"), "STAGE0_ENV=loaded\n");
    const withEnvFile = runNode(["--env-file-if-exists=.env", "x.ts"], dir);

    fs.writeFileSync(path.join(dir, "s.ts"), [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync("t.db");',
      'db.exec("PRAGMA journal_mode = WAL");',
      'const mode = db.prepare("PRAGMA journal_mode").get();',
      'db.exec("CREATE TABLE t (x INTEGER)");',
      'const r = db.prepare("INSERT INTO t VALUES (1)").run();',
      'console.log(JSON.stringify({ mode, rowidType: typeof r.lastInsertRowid }));',
    ].join("\n"));
    const sqlite = runNode(["s.ts"], dir);

    fs.mkdirSync(path.join(dir, "test"));
    fs.writeFileSync(path.join(dir, "test", "a.test.ts"),
      'import { test } from "node:test";\nimport { DatabaseSync } from "node:sqlite";\n' +
      'test("opens", () => { new DatabaseSync(":memory:"); });\n');
    fs.writeFileSync(path.join(dir, "test", "fakes.ts"), 'throw new Error("fakes.ts must not run as a test");\n');
    const testPlain = runNode(["--test", "test/*.test.ts"], dir);
    const testFlag = runNode(["--disable-warning=ExperimentalWarning", "--test", "test/*.test.ts"], dir);
    const testNodeOptions = runNode(["--test", "test/*.test.ts"], dir,
      { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" });

    const warned = (r: { stdout: string; stderr: string }) => /Warning/.test(r.stdout + "\n" + r.stderr);
    const testCount = (r: { stdout: string }) => Number(r.stdout.match(/tests (\d+)/)?.[1] ?? -1);

    const checks = {
      typeStripping: noEnvFile.code === 0,
      envFileIfExistsWithoutFile: noEnvFile.code === 0 && noEnvFile.stdout.startsWith("unset"),
      envFileIfExistsLoads: withEnvFile.stdout.startsWith("loaded"),
      importMetaFilename: withEnvFile.stdout.endsWith("string"),
      sqliteOpens: sqlite.code === 0,
      sqliteWal: /"wal"/i.test(sqlite.stdout),
      testGlobRunsOnlyTestFiles: testPlain.code === 0 && testCount(testPlain) === 1,
    };
    const warnings = {
      plainRun: warned(noEnvFile) || warned(sqlite),
      testRun: warned(testPlain),
      testRunWithFlag: warned(testFlag),
      testRunWithNodeOptions: warned(testNodeOptions),
    };
    const pass = Object.values(checks).every(Boolean);
    const version = process.version.replace(/^v/, "");
    let decision: string;
    if (!checks.sqliteOpens || !checks.sqliteWal) {
      decision = "Fallback: node:sqlite is unusable. Stop and redesign storage before phase 3.";
    } else if (!pass) {
      decision = "Fail: a required Node feature is missing on this version. See checks.";
    } else if (warnings.plainRun || warnings.testRun) {
      decision = `Warning only: add --disable-warning=ExperimentalWarning to dev and measure. ` +
        (warnings.testRunWithFlag
          ? "The flag does not reach node --test children: use NODE_OPTIONS in the test script."
          : "The flag reaches node --test children: add it to the test script too.");
    } else {
      decision = `Pass: pin ${version} in engines, .nvmrc and scripts/check-node.mjs.`;
    }
    const note = process.version.startsWith("v24.")
      ? null
      : `Ran on ${process.version}. The plan targets the newest Node 24 release; repeat \`stage0.ts q2\` ` +
        "under Node 24 (for example `nvm install 24 && nvm exec 24 node stage0.ts q2`) before pinning.";
    writeJson("q2.json", {
      node: process.version, platform: `${process.platform} ${process.arch}`, checks, warnings, pass, decision, note,
      raw: { noEnvFile, withEnvFile, sqlite, testPlain, testFlag, testNodeOptions },
    });
    console.log(`  Q2: ${decision}`);
    if (note) console.log(`  Note: ${note}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Q3a: effort field and values. About 10 tiny calls, no searches.

async function q3a(): Promise<void> {
  const result: any = {};
  for (const model of unique(Object.values(MODELS))) {
    const base = { model, max_tokens: 2048, messages: [{ role: "user", content: "Reply with the single word OK." }] };
    const baseline = brief(await tryCreate(base));
    const levels: any = {};
    for (const level of EFFORT_LEVELS) {
      levels[level] = brief(await tryCreate({ ...base, output_config: { effort: level } }));
      console.log(`  ${model} effort=${level}: ${levels[level].ok ? "accepted" : "rejected"}`);
    }
    const acceptedLevels = EFFORT_LEVELS.filter((l) => levels[l].ok);
    result[model] = {
      field: "output_config.effort",
      baseline,
      levels,
      acceptedLevels,
      fieldAccepted: acceptedLevels.length > 0,
      decision: acceptedLevels.length > 0
        ? `Pass: output_config.effort accepted with ${acceptedLevels.join(", ")}.`
        : "Fallback: field not accepted. Effort is null (omitted) for this model. Read the errors in levels.",
    };
  }
  writeJson("q3a.json", result);
}

// ---------------------------------------------------------------------------
// Q3b: thinking settings. About 6 tiny calls, no searches.

const THINKING_CANDIDATES: { label: string; value: Record<string, unknown> | null }[] = [
  { label: "omit", value: null },
  { label: "adaptive", value: { type: "adaptive" } },
  { label: "enabled-2048", value: { type: "enabled", budget_tokens: 2048 } },
];

async function q3b(): Promise<void> {
  const result: any = {};
  for (const model of unique(Object.values(MODELS))) {
    const tries: any[] = [];
    for (const c of THINKING_CANDIDATES) {
      const r = await tryCreate({
        model, max_tokens: 4096,
        messages: [{ role: "user", content: "In one sentence, why is the sky blue?" }],
        ...(c.value ? { thinking: c.value } : {}),
      });
      const thinkingBlocks = r.ok
        ? r.message.content.filter((b: any) => b.type === "thinking" || b.type === "redacted_thinking").length
        : null;
      tries.push({ label: c.label, value: c.value, ...brief(r), thinkingBlocks });
      console.log(`  ${model} thinking=${c.label}: ${r.ok ? `accepted (${thinkingBlocks} thinking blocks)` : "rejected"}`);
    }
    // Prefer adaptive: the API's own error for "enabled" says adaptive plus
    // output_config.effort is how thinking is controlled. Without a thinking
    // field Sonnet does not think at all, so effort would have less to tune.
    const adaptive = tries.find((t) => t.label === "adaptive" && t.ok);
    const first = adaptive ?? tries.find((t) => t.ok);
    result[model] = {
      tries,
      chosen: first?.value ?? null,
      decision: first
        ? `Pass: ${first.label === "omit" ? "send no thinking field" : `send thinking ${JSON.stringify(first.value)}`}.`
        : "Fallback: send no thinking field (no candidate was accepted; read the errors).",
    };
  }
  writeJson("q3b.json", result);
}

// ---------------------------------------------------------------------------
// Q3c: max_tokens. Six calls with search (up to 8 + 5 searches each).

async function q3c(): Promise<void> {
  const q3a = need("q3a.json", "q3a");
  const system = systemPrompt();
  const out: any = { runs: {} };
  const chosen: any = {};
  let hitLimit = false;
  for (const role of ["compare", "default"] as const) {
    const model = MODELS[role];
    const highest = (q3a[model]?.acceptedLevels ?? []).slice(-1)[0] ?? null; // most output, so a safe upper bound
    const messages = role === "compare"
      ? RECALL_TESTS.map((t) => userMessage(savedBlock([t.saved], WEEK_AGO), t.question))
      : ORDINARY_QUESTIONS.map((q) => userMessage(null, q));
    const runs: any[] = [];
    for (const content of messages) {
      const run = await stream("q3c", {
        model, max_tokens: 32000, system, messages: [{ role: "user", content }],
        tools: [webSearch(role === "compare" ? 8 : 5)], ...settingsFor(model, highest),
      });
      runs.push({ outputTokens: run.message.usage?.output_tokens ?? 0, stopReason: run.message.stop_reason });
      if (run.message.stop_reason === "max_tokens") hitLimit = true;
      console.log(`  ${role} ${model}: ${run.message.usage?.output_tokens} output tokens, ${run.message.stop_reason}`);
    }
    const largest = Math.max(...runs.map((r) => r.outputTokens));
    chosen[role] = Math.ceil((largest * 1.5) / 1024) * 1024;
    out.runs[role] = { model, effortUsed: highest, runs, largest };
  }
  if (hitLimit) {
    out.chosen = { compare: 16000, default: 4096 };
    out.decision = "Fallback: a run stopped at max_tokens 32000. Use 16000 (compare) and 4096 (default); note it as a known limit.";
  } else {
    out.chosen = chosen;
    out.decision = `Pass: maxTokens compare ${chosen.compare}, default ${chosen.default}.`;
  }
  writeJson("q3c.json", out);
}

// ---------------------------------------------------------------------------
// Q1 effort: lowest effort level that never calls the wrong price "unchanged".
// Up to (levels x 3) calls per model with up to 8 searches each; stops at the first passing level.

async function q1effort(): Promise<void> {
  const q3a = need("q3a.json", "q3a");
  const system = systemPrompt();
  const result: any = {};
  for (const model of unique(Object.values(MODELS))) {
    const levels: string[] = q3a[model]?.fieldAccepted ? q3a[model].acceptedLevels : [];
    if (levels.length === 0) {
      result[model] = { chosen: null, tries: [], decision: "Fallback: effort field not accepted (Q3a). Use the model's default effort." };
      continue;
    }
    const tries: any[] = [];
    let chosen: string | null = null;
    for (const level of levels) {
      const grades: any[] = [];
      for (const t of RECALL_TESTS) {
        const run = await stream("q1effort", {
          model, max_tokens: maxTokens("compare"), system,
          messages: [{ role: "user", content: userMessage(savedBlock([t.saved], WEEK_AGO), t.question) }],
          tools: [webSearch(8)], ...settingsFor(model, level),
        });
        const text = textOf(run.message);
        const g = grade(text, t.outdated, t.others);
        writeText(`q1effort/${safe(model)}-${level}-${t.name}.md`,
          `# ${model}, effort ${level}, test "${t.name}"\n\n` +
          `Verdict found for ${t.outdated}: ${g.verdict ?? "none"} -> ${g.pass ? "PASS" : "FAIL"}\n` +
          `Stop reason: ${run.message.stop_reason}. Searches: ${run.searchBlocks}.\n\n---\n\n${text}\n`);
        grades.push({ test: t.name, ...g, stopReason: run.message.stop_reason, searches: run.searchBlocks });
      }
      const passed = grades.every((g) => g.pass);
      tries.push({ level, passed, grades });
      console.log(`  ${model} effort=${level}: ${passed ? "pass" : "fail"} (${grades.map((g) => `${g.test}:${g.verdict ?? "none"}`).join(", ")})`);
      if (passed) {
        chosen = level;
        break;
      }
    }
    result[model] = chosen
      ? { chosen, tries, decision: `Pass: use effort ${chosen}. Read results/q1effort/ to confirm the auto-grading.` }
      : { chosen: null, tries, decision: "Fallback: no level passed. Use the model's documented default effort." };
  }
  writeJson("q1effort.json", result);
}

// ---------------------------------------------------------------------------
// Q1 speed: Opus vs Sonnet on the same compare question, 1, 3 and 5 searches, 3 runs each.
// 18 calls, up to 54 searches.

const SPEED_PRODUCTS = ["Neon", "Supabase", "Railway", "Render", "Aiven"];
const SPEED_SAVED: Saved = {
  id: 10,
  question: "Compare managed Postgres hosting from Neon, Supabase, Railway, Render and Aiven.",
  answer: "All five offer managed Postgres. Neon, Supabase and Render have free tiers; Railway bills by usage " +
    "with a monthly subscription; Aiven has a free plan and paid plans. Paid prices start at a few dollars " +
    "to a few tens of dollars a month.",
};

async function q1speed(): Promise<void> {
  if (MODELS.compare === MODELS.default) {
    writeJson("q1speed.json", { decision: "Skipped: MODEL_COMPARE equals MODEL_DEFAULT." });
    return;
  }
  need("q1effort.json", "q1effort");
  const system = systemPrompt();
  const table: any = {};
  for (const n of [1, 3, 5]) {
    const named = SPEED_PRODUCTS.slice(0, n);
    const question = `A week ago I asked you about Postgres hosting. Has pricing changed for ${listWords(named)}? ` +
      `Check ${n === 1 ? "it" : "each one"} with one search.`;
    table[n] = {};
    for (const model of [MODELS.compare, MODELS.default]) {
      const runs: any[] = [];
      for (let i = 0; i < 3; i++) {
        const run = await stream("q1speed", {
          model, max_tokens: maxTokens("compare"), system,
          messages: [{ role: "user", content: userMessage(savedBlock([SPEED_SAVED], WEEK_AGO), question) }],
          tools: [webSearch(n)], ...settingsFor(model),
        });
        runs.push({ firstTextMs: run.firstTextMs, totalMs: Math.round(run.totalMs), searches: run.searchBlocks });
      }
      const firsts = runs.map((r) => r.firstTextMs).filter((x): x is number => x !== null);
      table[n][model] = { runs, medianFirstTextMs: firsts.length ? Math.round(median(firsts)) : null };
      console.log(`  ${n} searches, ${model}: median first text ${table[n][model].medianFirstTextMs} ms`);
    }
  }
  const rows = [1, 3, 5].map((n) => {
    const opus = table[n][MODELS.compare].medianFirstTextMs;
    const sonnet = table[n][MODELS.default].medianFirstTextMs;
    return { searches: n, compareMs: opus, defaultMs: sonnet, ratio: opus && sonnet ? +(opus / sonnet).toFixed(2) : null };
  });
  const pass = rows.every((r) => r.ratio !== null && r.ratio <= 1.5);
  writeJson("q1speed.json", {
    models: MODELS, rows, table, pass,
    decision: pass
      ? `Pass: ${MODELS.compare} stays the compare model (worst ratio ${Math.max(...rows.map((r) => r.ratio ?? 0))}).`
      : `Fallback: compare turns use ${MODELS.default}. Make the "Q1 speed fails" edits listed under the Phase 0 table.`,
  });
}

// ---------------------------------------------------------------------------
// Q3d: is a lower max_uses accepted on a continuation? About 4 calls, up to 15 searches.

async function q3d(): Promise<void> {
  const model = MODELS.default;
  const base = { model, max_tokens: maxTokens("default"), ...settingsFor(model) };

  // Simulated continuation: cut a finished search turn after its last search
  // result, and send that as a trailing assistant message with a lower max_uses.
  const q = "Find the current monthly price of Neon's Launch plan and of Supabase Pro. Search once for each.";
  const first = await stream("q3d", { ...base, messages: [{ role: "user", content: q }], tools: [webSearch(2)] });
  const content = first.message.content;
  let lastResult = -1;
  content.forEach((b: any, i: number) => { if (b.type === "web_search_tool_result") lastResult = i; });
  let simulated: any;
  if (lastResult < 0) {
    simulated = { tested: false, reason: "The first call made no search." };
  } else {
    const r = await tryCreate({
      ...base, tools: [webSearch(1)],
      messages: [{ role: "user", content: q }, { role: "assistant", content: content.slice(0, lastResult + 1) }],
    });
    simulated = { tested: true, ...brief(r) };
  }
  console.log(`  simulated continuation with lower max_uses: ${simulated.tested ? (simulated.ok ? "accepted" : "rejected") : "not tested"}`);

  // Real attempt to produce pause_turn: a question that needs many searches.
  // A re-run reuses an earlier attempt that did not produce one, to save its 12 searches.
  const big = "List the current monthly starting price of each of these twelve products, searching once for each: " +
    "Neon, Supabase, Railway, Render, Aiven, PlanetScale, Heroku Postgres, DigitalOcean Managed Databases, " +
    "Crunchy Bridge, Xata, Tembo, Timescale.";
  const previous = readJson("q3d.json")?.real;
  if (previous && previous.produced === false) {
    console.log("  real pause_turn: reusing the earlier attempt (not produced)");
    const accepted = simulated.tested && simulated.ok;
    writeJson("q3d.json", {
      simulated, real: previous, pass: accepted === true,
      decision: accepted
        ? "Pass: a lower max_uses is accepted on a continuation (simulated continuation only; no real pause_turn was produced)."
        : "Fallback: pauseTurnLimit 1, repeat the original max_uses, and make the \"Q3d fails\" edits.",
    });
    return;
  }
  const run = await stream("q3d", { ...base, messages: [{ role: "user", content: big }], tools: [webSearch(12)] });
  let real: any = { produced: run.message.stop_reason === "pause_turn", stopReason: run.message.stop_reason, searches: run.searchBlocks };
  if (real.produced) {
    writeJson("fixtures/pause_turn.json", { events: run.events, finalMessage: run.message });
    const remaining = Math.max(1, 12 - run.searchBlocks);
    const r = await tryCreate({
      ...base, tools: [webSearch(remaining)],
      messages: [{ role: "user", content: big }, { role: "assistant", content: run.message.content }],
    });
    real = { ...real, continuationMaxUses: remaining, ...brief(r) };
  }
  console.log(`  real pause_turn: ${real.produced ? `produced; continuation ${real.ok ? "accepted" : "rejected"}` : "not produced"}`);

  const accepted = real.produced ? real.ok : (simulated.tested && simulated.ok);
  writeJson("q3d.json", {
    simulated, real,
    pass: accepted === true,
    decision: accepted
      ? `Pass: a lower max_uses is accepted on a continuation (${real.produced ? "real pause_turn" : "simulated continuation only"}).`
      : "Fallback: pauseTurnLimit 1, repeat the original max_uses, and make the \"Q3d fails\" edits.",
  });
}

// ---------------------------------------------------------------------------
// Q3e: the error when web search is turned off. Needs a second key whose
// organisation has web search off; otherwise the fallback rule applies.

async function q3e(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY_NO_SEARCH;
  if (!key) {
    writeJson("q3e.json", {
      tested: false,
      decision: 'Fallback: no key with web search turned off was given. Match status 400 plus "web search" (case-insensitive) in the message.',
    });
    return;
  }
  const r = await tryCreate({
    model: MODELS.default, max_tokens: 512, tools: [webSearch(1)],
    messages: [{ role: "user", content: "What is today's top headline? Search for it." }],
  }, await client({ apiKey: key }));
  let decision: string;
  if (r.ok) {
    decision = "Not tested: the request succeeded, so web search is on for that key. Fallback rule applies.";
  } else if (r.status === 400 && r.type && r.type !== "invalid_request_error") {
    decision = `Pass: match error type "${r.type}".`;
  } else {
    decision = 'Fallback: no distinct type. Match status 400 plus "web search" (case-insensitive) in the message' +
      (/web search/i.test(r.error ?? "") ? "." : `. Warning: this message does not contain "web search": ${r.error}`);
  }
  writeJson("q3e.json", { tested: true, ...brief(r), decision });
}

// ---------------------------------------------------------------------------
// Fixtures for test/claude.test.ts. Two calls, up to 3 searches.

async function fixtures(): Promise<void> {
  const model = MODELS.default;
  const system = systemPrompt();
  const q = "What do the free tiers of Neon and Supabase include today? Search once for each.";
  const base = { model, max_tokens: maxTokens("default"), system, messages: [{ role: "user", content: userMessage(null, q) }], ...settingsFor(model) };

  const ordinary = await stream("fixtures", { ...base, tools: [webSearch(2)] });
  writeJson("fixtures/ordinary_two_searches.json", { events: ordinary.events, finalMessage: ordinary.message });

  const limited = await stream("fixtures", { ...base, tools: [webSearch(1)] });
  const hasError = limited.message.content.some((b: any) =>
    b.type === "web_search_tool_result" && !Array.isArray(b.content) && b.content?.type === "web_search_tool_result_error");
  writeJson("fixtures/search_error.json", { events: limited.events, finalMessage: limited.message });

  const pause = fs.existsSync(path.join(RESULTS, "fixtures", "pause_turn.json"));
  writeJson("fixtures.json", {
    ordinaryTwoSearches: { searches: ordinary.searchBlocks, stopReason: ordinary.message.stop_reason },
    searchError: { searches: limited.searchBlocks, containsSearchError: hasError },
    pauseTurn: { produced: pause },
    decision: [
      `ordinary_two_searches.json saved (${ordinary.searchBlocks} searches).`,
      hasError ? "search_error.json saved with a search error." : "search_error.json saved but has no search error: hand-edit one result into an error.",
      pause ? "pause_turn.json saved by q3d." : "pause_turn.json not produced: hand-write it from ordinary_two_searches.json with stop_reason pause_turn.",
    ].join(" "),
  });
  console.log(`  search error produced: ${hasError}; pause_turn fixture: ${pause}`);
}

// ---------------------------------------------------------------------------
// Q3f: search counting and citation shape, from all runs so far. Free.

async function q3f(): Promise<void> {
  const file = path.join(RESULTS, "search_counts.jsonl");
  if (!fs.existsSync(file)) fail("No runs recorded yet. Run the earlier items first.");
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const missingUsage = rows.filter((r) => r.usageSearches === null).length;
  const mismatches = rows.filter((r) => r.usageSearches !== null && r.usageSearches !== r.searchBlocks);
  const fx = readJson("fixtures/ordinary_two_searches.json");
  const citationExample = fx?.events?.find((e: any) => e.type === "content_block_delta" && e.delta?.type === "citations_delta") ?? null;
  const pass = rows.length > 0 && missingUsage === 0 && mismatches.length === 0;
  writeJson("q3f.json", {
    runs: rows.length, missingUsage, mismatches, citationExample,
    pass,
    decision: pass
      ? "Pass: counting web_search server_tool_use blocks matches usage.server_tool_use.web_search_requests."
      : "Fallback: count blocks for the cap during the stream, and save the usage figure as search_count.",
  });
  if (!citationExample) console.log("  Warning: no citations_delta event found in the ordinary fixture.");
}

// ---------------------------------------------------------------------------
// Q3g: does maxRetries: 0 turn off SDK retries? Uses a local mock server. Free.

async function q3g(): Promise<void> {
  const Anthropic = await loadSdk();
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    req.resume();
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "stage0 mock" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const attempt = async (options: Record<string, unknown>) => {
    count = 0;
    const c = new Anthropic({ apiKey: "stage0-mock", baseURL: `http://127.0.0.1:${port}`, ...options });
    try {
      await c.messages.create({ model: "mock", max_tokens: 1, messages: [{ role: "user", content: "x" }] });
    } catch {
      // expected: 429
    }
    return count;
  };
  const withZero = await attempt({ maxRetries: 0 });
  const withDefault = await attempt({});
  server.close();
  const pass = withZero === 1;
  writeJson("q3g.json", {
    sdkVersion: sdkVersion(),
    requestsWithMaxRetries0: withZero,
    requestsWithSdkDefault: withDefault,
    pass,
    decision: pass
      ? "Pass: maxRetries 0 sends one request; keep the single app-level 429 retry."
      : "Fallback: keep the SDK default retries and remove the app-level 429 retry (\"Q3g fails\" edits).",
  });
  console.log(`  requests: maxRetries 0 -> ${withZero}, SDK default -> ${withDefault}`);
}

// ---------------------------------------------------------------------------
// Summary: one Markdown file to copy into the design doc. Free.

function summary(): void {
  const r = (name: string) => readJson(name);
  const q2r = r("q2.json"), q3ar = r("q3a.json"), q3br = r("q3b.json"), q3cr = r("q3c.json");
  const q1er = r("q1effort.json"), q1sr = r("q1speed.json"), q3dr = r("q3d.json"), q3er = r("q3e.json");
  const q3fr = r("q3f.json"), q3gr = r("q3g.json"), fxr = r("fixtures.json");
  const perModel = (x: any) => x ? unique(Object.values(MODELS)).map((m) => `${m}: ${x[m]?.decision ?? "not run"}`).join(" ") : "Not yet run";
  const rows: [string, string][] = [
    ["Q1 speed", q1sr?.decision ?? "Not yet run"],
    ["Q1 effort", perModel(q1er)],
    ["Q2 Node", q2r ? `${q2r.decision}${q2r.note ? ` ${q2r.note}` : ""}` : "Not yet run"],
    ["Q3a effort field", perModel(q3ar)],
    ["Q3b thinking", perModel(q3br)],
    ["Q3c `max_tokens`", q3cr?.decision ?? "Not yet run"],
    ["Q3d `max_uses` on continuation", q3dr?.decision ?? "Not yet run"],
    ["Q3e search disabled", q3er?.decision ?? "Not yet run"],
    ["Q3f citations and counts", q3fr?.decision ?? "Not yet run"],
    ["Q3g SDK retries", q3gr?.decision ?? "Not yet run"],
    ["Fixtures", fxr?.decision ?? "Not yet run"],
  ];
  const settings = unique(Object.values(MODELS)).map((m) => {
    const effort = q3ar?.[m]?.fieldAccepted ? (q1er?.[m]?.chosen ?? null) : null;
    const thinking = q3br?.[m]?.chosen ?? null;
    return `  "${m}": { effort: ${JSON.stringify(effort)}, thinking: ${JSON.stringify(thinking)} },`;
  }).join("\n");
  const byModel = Object.entries(spend.byModel)
    .map(([m, v]: [string, any]) => `| ${m} | ${v.calls} | ${v.inputTokens} | ${v.outputTokens} |`).join("\n");
  const md = `# Stage 0 results

Run on ${new Date().toISOString().slice(0, 10)} with Node ${process.version}, SDK ${sdkVersion() ?? "not installed"},
models ${MODELS.default} (default) and ${MODELS.compare} (compare).

## Results column for the Phase 0 table

| Item | Result |
| --- | --- |
${rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`).join("\n")}

## Values for the build

\`\`\`ts
// src/config.ts
const MODEL_SETTINGS = {
${settings}
};
const MAX_TOKENS = ${JSON.stringify(q3cr?.chosen ?? { compare: 16000, default: 4096 })};
\`\`\`

*   Node to pin: ${q2r?.node ?? "not run"} (${q2r?.note ? "see the Q2 note" : "as tested"}).
*   \`@anthropic-ai/sdk\` to pin: ${sdkVersion() ?? "not installed"}.
*   Fixtures to copy into \`test/fixtures/\`: \`results/fixtures/*.json\`.

## Spend so far

Searches: ${spend.searches} (about $${(spend.searches * SEARCH_PRICE).toFixed(2)}). Token costs depend on current
model prices; the counts are below.

| Model | Calls | Input tokens | Output tokens |
| --- | --- | --- | --- |
${byModel}
`;
  writeText("summary.md", md);
  console.log("  wrote results/summary.md");
}

// ---------------------------------------------------------------------------

const ITEMS: Record<string, { run: () => Promise<void> | void; cost: string }> = {
  q2: { run: q2, cost: "free (local Node checks)" },
  q3a: { run: q3a, cost: "about 12 tiny calls, no searches" },
  q3b: { run: q3b, cost: "about 6 tiny calls, no searches" },
  q3c: { run: q3c, cost: "6 calls, up to 39 searches" },
  q1effort: { run: q1effort, cost: "3 calls per effort level per model, up to 8 searches each; stops at the first passing level" },
  q1speed: { run: q1speed, cost: "18 calls, up to 54 searches" },
  q3d: { run: q3d, cost: "about 4 calls, up to 15 searches" },
  q3e: { run: q3e, cost: "1 tiny call, only if ANTHROPIC_API_KEY_NO_SEARCH is set" },
  fixtures: { run: fixtures, cost: "2 calls, up to 3 searches" },
  q3f: { run: q3f, cost: "free (reads earlier runs)" },
  q3g: { run: q3g, cost: "free (local mock server)" },
  summary: { run: summary, cost: "free" },
};

const item = process.argv[2];
if (!item || item === "help" || !ITEMS[item]) {
  console.log("Usage: node --env-file-if-exists=.env stage0.ts <item>\n\nItems, in run order:");
  for (const [name, v] of Object.entries(ITEMS)) console.log(`  ${name.padEnd(9)} ${v.cost}`);
  process.exit(item && item !== "help" ? 1 : 0);
}
fs.mkdirSync(RESULTS, { recursive: true });
console.log(`Stage 0: ${item}`);
await ITEMS[item].run();
