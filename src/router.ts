import type { Config, RecallResult, Route } from "./types.ts";

// Step 3 of the design: the route follows from the recall result alone.
export function route(recall: RecallResult | null, config: Config): Route {
  if (recall === null) return modelRoute("default", "ordinary", config);
  if (recall.kind === "hit" || recall.kind === "near") return modelRoute("compare", "compare", config);
  // A miss with no topic words leaves nothing to search for and nothing to compare.
  if (recall.topicWords.length === 0) return { kind: "direct", reason: "no_record_direct" };
  return modelRoute("default", "no_record", config);
}

function modelRoute(
  role: "default" | "compare", reason: "ordinary" | "compare" | "no_record", config: Config,
): Route {
  return {
    kind: "model",
    role,
    model: config.models[role],
    effort: config.effort[role],
    thinking: config.thinking[role],
    maxTokens: config.maxTokens[role],
    maxSearches: config.searchCap[role],
    reason,
  };
}
