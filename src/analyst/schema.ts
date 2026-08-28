import { z } from "zod";

/**
 * Kept to plain scalar types with no JSON-Schema range constraints - the range
 * check happens in `validateForecast` instead. Structured outputs are stricter
 * about what schema keywords they accept than zod is about emitting them, and a
 * rejected request costs a whole scan.
 */
export const ForecastSchema = z.object({
  resolution_reading: z
    .string()
    .describe("What must literally be true for this to resolve YES, in your own words."),
  ambiguity_flag: z
    .boolean()
    .describe("True if the resolution criteria are ambiguous enough to change the answer."),
  base_rate: z
    .string()
    .describe("The reference class you used and its historical frequency."),
  key_drivers: z.array(z.string()).describe("The factors that actually decide this."),
  evidence_for: z.array(z.string()).describe("Diagnostic evidence pointing to YES."),
  evidence_against: z.array(z.string()).describe("Diagnostic evidence pointing to NO."),
  stale_knowledge: z
    .boolean()
    .describe("True if the outcome likely hinges on facts after your training cutoff."),
  probability: z
    .number()
    .describe("Probability that this resolves YES, between 0 and 1."),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("Your confidence in that probability."),
  abstain: z.boolean().describe("True if you cannot responsibly judge this question."),
  abstain_reason: z.string().describe("Why you abstained, or an empty string."),
});

export type ForecastPayload = z.infer<typeof ForecastSchema>;

export class ForecastValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastValidationError";
  }
}

/**
 * The model returns a schema-valid object; that does not make it a usable
 * forecast. A probability of exactly 0 or 1 is a modeling error on a question
 * that has not resolved yet, and it makes Kelly sizing blow up, so we clamp.
 */
export function validateForecast(payload: ForecastPayload): ForecastPayload {
  const p = payload.probability;
  if (!Number.isFinite(p)) {
    throw new ForecastValidationError(`probability was not a number: ${String(p)}`);
  }
  if (p < 0 || p > 1) {
    throw new ForecastValidationError(`probability ${p} is outside [0, 1]`);
  }
  return { ...payload, probability: Math.min(0.99, Math.max(0.01, p)) };
}
