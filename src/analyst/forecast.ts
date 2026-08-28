import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { Config } from "../config.ts";
import type { BinaryMarket, Forecast, ForecastCost, ForecastRun } from "../types.ts";
import { FORECAST_SYSTEM, RESEARCH_SYSTEM, forecastPrompt, researchPrompt } from "./prompt.ts";
import { ForecastSchema, validateForecast } from "./schema.ts";

/** USD per million tokens, by model. Used for the cost line in `poly report`. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Web search is billed per search, separately from tokens. */
const USD_PER_SEARCH = 0.01;

export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Model declined to answer${category ? ` (${category})` : ""}`);
    this.name = "RefusalError";
  }
}

function priceUsage(model: string, usage: Anthropic.Usage, searches: number): ForecastCost {
  const rates = PRICING[model] ?? PRICING["claude-opus-5"]!;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const usd =
    (input * rates.input +
      output * rates.output +
      // Cache reads bill at ~0.1x input, writes at ~1.25x.
      cacheRead * rates.input * 0.1 +
      cacheWrite * rates.input * 1.25) /
      1_000_000 +
    searches * USD_PER_SEARCH;

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    usd,
  };
}

function addCost(a: ForecastCost, b: ForecastCost): ForecastCost {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    usd: a.usd + b.usd,
  };
}

const ZERO_COST: ForecastCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0,
};

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function countSearches(content: Anthropic.ContentBlock[]): number {
  return content.filter((b) => b.type === "server_tool_use").length;
}

/**
 * Stage 1: gather evidence with web search.
 *
 * This stage exists because a model's training cutoff is a structural
 * disadvantage against a market that reprices on this morning's news. Without
 * it, the forecaster is systematically stale on exactly the markets where the
 * crowd is most active, and the calibration numbers will show it.
 */
export async function researchMarket(
  client: Anthropic,
  cfg: Config,
  market: BinaryMarket,
  now: Date,
): Promise<{ brief: string; cost: ForecastCost }> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: researchPrompt(market, now) },
  ];

  let cost = ZERO_COST;
  // Accumulated across continuations: a paused turn can emit part of the brief
  // before it pauses, and that text is only in that response's content. Keeping
  // just the last response silently truncates every brief that took more than
  // one turn - the long-running research, which is the research worth having.
  const parts: string[] = [];

  // Server-side tool loops pause at 10 iterations; resume by re-sending.
  for (let continuation = 0; continuation < 4; continuation++) {
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: 8_000,
      system: [
        { type: "text", text: RESEARCH_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: cfg.effort },
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: cfg.researchMaxSearches,
        },
      ],
      messages,
    });

    cost = addCost(cost, priceUsage(cfg.model, response.usage, countSearches(response.content)));

    if (response.stop_reason === "refusal") {
      throw new RefusalError(response.stop_details?.category ?? null);
    }

    const text = textOf(response.content);
    if (text) parts.push(text);

    if (response.stop_reason !== "pause_turn") break;

    // Do NOT append a "continue" message - the API resumes from the trailing
    // server_tool_use block on its own.
    messages.push({ role: "assistant", content: response.content });
  }

  return { brief: parts.join("\n\n"), cost };
}

/** Stage 2: the blind, structured forecast. */
export async function forecastMarket(
  client: Anthropic,
  cfg: Config,
  market: BinaryMarket,
  now: Date,
  research: string | null,
): Promise<{ forecast: Forecast; cost: ForecastCost }> {
  const response = await client.messages.parse({
    model: cfg.model,
    max_tokens: 8_000,
    system: [
      { type: "text", text: FORECAST_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    thinking: { type: "adaptive" },
    output_config: {
      effort: cfg.effort,
      format: zodOutputFormat(ForecastSchema),
    },
    messages: [{ role: "user", content: forecastPrompt(market, now, research) }],
  });

  if (response.stop_reason === "refusal") {
    throw new RefusalError(response.stop_details?.category ?? null);
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(`Model returned no parseable forecast (stop_reason=${response.stop_reason})`);
  }

  const payload = validateForecast(parsed);

  const forecast: Forecast = {
    resolutionReading: payload.resolution_reading,
    ambiguous: payload.ambiguity_flag,
    keyDrivers: payload.key_drivers,
    baseRate: payload.base_rate,
    evidenceFor: payload.evidence_for,
    evidenceAgainst: payload.evidence_against,
    staleKnowledge: payload.stale_knowledge,
    probability: payload.probability,
    confidence: payload.confidence,
    abstain: payload.abstain,
    abstainReason: payload.abstain_reason,
  };

  return { forecast, cost: priceUsage(cfg.model, response.usage, 0) };
}

export async function runForecast(
  client: Anthropic,
  cfg: Config,
  market: BinaryMarket,
  now: Date,
): Promise<ForecastRun> {
  let research: string | null = null;
  let cost = ZERO_COST;

  if (cfg.research) {
    const stage = await researchMarket(client, cfg, market, now);
    research = stage.brief || null;
    cost = addCost(cost, stage.cost);
  }

  const stage = await forecastMarket(client, cfg, market, now, research);
  return {
    forecast: stage.forecast,
    research,
    cost: addCost(cost, stage.cost),
  };
}
