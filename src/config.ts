import type { Config } from "./types.ts";

// Values measured in Stage 0 (docs/stage0/summary.md).
const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TOKENS_COMPARE = 43008;
const MAX_TOKENS_DEFAULT = 32768;
const SEARCH_CAP_DEFAULT = 5;
const SEARCH_CAP_COMPARE = 8;
const RECALL_CAP = 5;
const NEAR_MISS_DAYS = 3;
const UNDATED_WINDOW = 30;
const HISTORY_TURNS = 10;
const PAUSE_TURN_LIMIT = 1;
const DEFAULT_PORT = 3000;
const DEFAULT_DB_PATH = "data/turns.db";

// Only models that Stage 0 measured appear here. Any other model ID is sent
// no effort and no thinking setting, so it never gets a setting it was not tested with.
const MODEL_SETTINGS: Record<string, { effort: string; thinking: Record<string, unknown> }> = {
  "claude-sonnet-5-5": { effort: "low", thinking: { type: "adaptive" } },
  "claude-opus-5-5": { effort: "low", thinking: { type: "adaptive" } }, // kept for MODEL_COMPARE overrides
};

// An unset or empty variable counts as not set.
function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parsePort(text: string | undefined): number {
  if (text === undefined) return DEFAULT_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535 (got "${text}").`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultModel = optional(env, "MODEL_DEFAULT") ?? DEFAULT_MODEL;
  const compareModel = optional(env, "MODEL_COMPARE") ?? DEFAULT_MODEL;
  const defaultSettings = MODEL_SETTINGS[defaultModel];
  const compareSettings = MODEL_SETTINGS[compareModel];

  return {
    apiKey: optional(env, "ANTHROPIC_API_KEY") ?? null,
    models: { default: defaultModel, compare: compareModel },
    effort: {
      default: defaultSettings?.effort ?? null,
      compare: compareSettings?.effort ?? null,
    },
    thinking: {
      default: defaultSettings?.thinking ?? null,
      compare: compareSettings?.thinking ?? null,
    },
    maxTokens: { default: MAX_TOKENS_DEFAULT, compare: MAX_TOKENS_COMPARE },
    searchCap: { default: SEARCH_CAP_DEFAULT, compare: SEARCH_CAP_COMPARE },
    recallCap: RECALL_CAP,
    nearMissDays: NEAR_MISS_DAYS,
    undatedWindow: UNDATED_WINDOW,
    historyTurns: HISTORY_TURNS,
    pauseTurnLimit: PAUSE_TURN_LIMIT,
    port: parsePort(optional(env, "PORT")),
    dbPath: optional(env, "DB_PATH") ?? DEFAULT_DB_PATH,
  };
}
