import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import assert from "node:assert/strict";
import test from "node:test";

import { ForecastSchema } from "../src/analyst/schema.ts";

/**
 * The forecaster's request shape could not be exercised against the live API
 * from the environment this was built in, so it is pinned here instead.
 *
 * The value is in the type annotations, not the assertions: each object below
 * is declared as the SDK's own parameter type, so `npm run typecheck` fails if
 * the tool version string, the `output_config` layout, or the thinking config
 * stops matching what the installed SDK accepts. That catches the whole class
 * of error this file exists for - a request the API would reject at runtime -
 * without spending a token or needing a credential.
 *
 * These must stay in sync with src/analyst/forecast.ts. They are deliberately
 * a copy rather than an import: a shared constant would let a wrong shape be
 * wrong in both places and still pass.
 */

test("the research request shape is what the SDK accepts", () => {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: "claude-opus-5",
    max_tokens: 8_000,
    system: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    messages: [{ role: "user", content: "…" }],
  };

  const tool = params.tools?.[0] as Anthropic.WebSearchTool20260209;
  // The dynamic-filtering variant, which is the one Opus 5 supports. The older
  // web_search_20250305 is for pre-4.6 models.
  assert.equal(tool.type, "web_search_20260209");
  assert.equal(tool.name, "web_search");

  // effort lives inside output_config, not at the top level.
  assert.equal(params.output_config?.effort, "high");
  assert.equal(params.thinking?.type, "adaptive");

  // budget_tokens was removed on Opus 5 and is rejected with a 400.
  assert.ok(!("budget_tokens" in (params.thinking ?? {})));
});

test("the forecast request carries effort and a structured format together", () => {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: "claude-opus-5",
    max_tokens: 8_000,
    system: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(ForecastSchema),
    },
    messages: [{ role: "user", content: "…" }],
  };

  // Both keys on one output_config object - the combination that was unverified.
  assert.equal(params.output_config?.effort, "high");
  assert.equal(params.output_config?.format?.type, "json_schema");

  // The deprecated top-level parameter must not come back.
  assert.ok(!("output_format" in params));
});

test("the forecast schema round-trips through zodOutputFormat", () => {
  const format = zodOutputFormat(ForecastSchema);
  assert.equal(format.type, "json_schema");

  const schema = format.schema as { properties?: Record<string, unknown> };
  // The fields the engine reads off `parsed_output`. A rename here silently
  // turns every forecast into a validation failure at scan time.
  for (const field of [
    "probability",
    "confidence",
    "abstain",
    "stale_knowledge",
    "ambiguity_flag",
    "resolution_reading",
  ]) {
    assert.ok(schema.properties?.[field], `forecast schema lost the ${field} field`);
  }
});
