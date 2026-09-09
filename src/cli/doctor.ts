import Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { getJson } from "../polymarket/http.ts";
import { asBinaryMarket, describeMarketShape, normalizeMarket } from "../polymarket/gamma.ts";
import { fetchBook, quoteFromBook } from "../polymarket/clob.ts";

type Check = { name: string; ok: boolean; detail: string };

/**
 * Verify every external dependency before a scan spends money on any of them.
 * Gamma's field shapes have changed before; when they change again this is the
 * command that tells you which field moved rather than leaving you to infer it
 * from an empty scan.
 */
export async function doctor(): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  let cfg;
  try {
    cfg = loadConfig();
    add("config", true, `model=${cfg.model} effort=${cfg.effort} research=${cfg.research}`);
  } catch (err) {
    add("config", false, String(err));
    report(checks);
    return 1;
  }

  try {
    const db = openDb(cfg.dbPath);
    db.close();
    add("database", true, cfg.dbPath);
  } catch (err) {
    add("database", false, String(err));
  }

  // A key mangled in transit - a newline from a wrapped paste, stray quotes,
  // trailing whitespace - fails as a plain 401, which reads identically to a
  // revoked key and sends you back to the console to reissue a perfectly good
  // one. Check the shape before blaming the credential.
  const rawKey = process.env["ANTHROPIC_API_KEY"];
  if (rawKey !== undefined) {
    const problems: string[] = [];
    if (/\s/.test(rawKey)) {
      problems.push("contains whitespace or a line break - it was probably split when pasted");
    }
    if (rawKey !== rawKey.trim()) problems.push("has leading or trailing whitespace");
    if (/^['"]|['"]$/.test(rawKey.trim())) problems.push("is wrapped in quotes");
    if (rawKey.trim().length < 40) {
      problems.push(`is only ${rawKey.trim().length} characters - it looks truncated`);
    }
    if (problems.length > 0) {
      add(
        "api key shape",
        false,
        `ANTHROPIC_API_KEY ${problems.join("; ")}.\n` +
          `    Re-paste it as one unbroken line. This fails as a plain 401, so it is\n` +
          `    easy to mistake for a bad key when the key itself is fine.`,
      );
    }
  }

  // Anthropic: a models lookup proves credentials without spending on tokens.
  try {
    const client = new Anthropic();
    const model = await client.models.retrieve(cfg.model);
    add("anthropic auth", true, `reachable, ${model.id} available`);
  } catch (err) {
    add("anthropic auth", false, `${String(err)}\n    Set ANTHROPIC_API_KEY or run 'ant auth login'.`);
  }

  // Gamma: fetch one live market and show what the payload actually contains.
  let sampleTokenId: string | null = null;
  try {
    const raw = await getJson<unknown[]>(`${cfg.gammaBase}/markets?closed=false&active=true&limit=5`);
    const rows = Array.isArray(raw) ? raw : [];
    const first = rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      add("gamma api", false, "reachable but returned no markets");
    } else {
      const market = normalizeMarket(first);
      const binary = market ? asBinaryMarket(market) : null;
      sampleTokenId = binary?.yesTokenId ?? null;
      add(
        "gamma api",
        market !== null,
        market
          ? `parsed "${truncate(market.question, 60)}"\n` +
              `    outcomes=${JSON.stringify(market.outcomes)} ` +
              `liquidity=${market.liquidity} volume=${market.volume} ` +
              `binary=${binary !== null}`
          : "reachable but the payload did not normalize - raw shape below",
      );
      if (!market || !binary) {
        add("gamma shape", false, `\n${describeMarketShape(first)}`);
      }
    }
  } catch (err) {
    add("gamma api", false, String(err));
  }

  // CLOB: an order book we can actually price against.
  if (sampleTokenId) {
    try {
      const book = await fetchBook(cfg.clobBase, sampleTokenId);
      const quote = quoteFromBook(book);
      add(
        "clob api",
        quote !== null,
        quote
          ? `book ok: bid=${quote.yesBid.toFixed(3)} ask=${quote.yesAsk.toFixed(3)} ` +
              `spread=${quote.spread.toFixed(3)} depth=${quote.yesAskSize.toFixed(0)}`
          : `book returned but was empty or crossed (${book.bids.length} bids, ${book.asks.length} asks)`,
      );
    } catch (err) {
      add("clob api", false, String(err));
    }
  } else {
    add("clob api", false, "skipped - no sample token id from gamma");
  }

  return report(checks);
}

function report(checks: Check[]): number {
  console.log("");
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(16)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log("");
  console.log(failed === 0 ? "  All checks passed. `npm run scan` is safe to run." : `  ${failed} check(s) failed.`);
  console.log("");
  return failed === 0 ? 0 : 1;
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}
