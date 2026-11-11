import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("an empty environment gives the Stage 0 defaults", () => {
  const config = loadConfig({});
  assert.equal(config.apiKey, null);
  assert.deepEqual(config.models, { default: "claude-sonnet-5-5", compare: "claude-sonnet-5-5" });
  assert.deepEqual(config.effort, { default: "low", compare: "low" });
  assert.deepEqual(config.thinking.default, { type: "adaptive" });
  assert.deepEqual(config.thinking.compare, { type: "adaptive" });
  assert.deepEqual(config.maxTokens, { default: 32768, compare: 43008 });
  assert.deepEqual(config.searchCap, { default: 5, compare: 8 });
  assert.equal(config.recallCap, 5);
  assert.equal(config.nearMissDays, 3);
  assert.equal(config.undatedWindow, 30);
  assert.equal(config.historyTurns, 10);
  assert.equal(config.pauseTurnLimit, 1);
  assert.equal(config.port, 3000);
  assert.equal(config.dbPath, "data/turns.db");
});

test("an empty key gives null, and a set key is kept", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "" }).apiKey, null);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "  " }).apiKey, null);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "sk-test" }).apiKey, "sk-test");
});

test("empty optional variables count as unset", () => {
  const config = loadConfig({ MODEL_DEFAULT: "", MODEL_COMPARE: "", PORT: "", DB_PATH: "" });
  assert.equal(config.models.default, "claude-sonnet-5-5");
  assert.equal(config.port, 3000);
  assert.equal(config.dbPath, "data/turns.db");
});

test("PORT=abc throws a message naming PORT", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "0" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "30.5" }), /PORT/);
});

test("a valid PORT and DB_PATH are used", () => {
  const config = loadConfig({ PORT: "8080", DB_PATH: "/tmp/x.db" });
  assert.equal(config.port, 8080);
  assert.equal(config.dbPath, "/tmp/x.db");
});

test("model variables override the defaults, with settings only for measured models", () => {
  const opus = loadConfig({ MODEL_COMPARE: "claude-opus-5-5" });
  assert.equal(opus.models.compare, "claude-opus-5-5");
  assert.equal(opus.effort.compare, "low");
  assert.equal(opus.models.default, "claude-sonnet-5-5");

  const unknown = loadConfig({ MODEL_DEFAULT: "some-other-model" });
  assert.equal(unknown.models.default, "some-other-model");
  assert.equal(unknown.effort.default, null);
  assert.equal(unknown.thinking.default, null);
  assert.equal(unknown.effort.compare, "low");
});
