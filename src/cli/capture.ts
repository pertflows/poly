import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../config.ts";
import { getJson } from "../polymarket/http.ts";
import { asBinaryMarket, normalizeMarket } from "../polymarket/gamma.ts";

/**
 * Capture live Gamma and CLOB payloads into `test/fixtures/` so the test suite
 * pins the shapes the APIs actually send rather than the shapes we assumed.
 *
 * This exists because the two network-facing surfaces cannot be verified from
 * an environment without egress to Polymarket. Run it once from a machine that
 * can reach the APIs, commit what it writes, and `test/fixtures.test.ts` starts
 * asserting against real data instead of skipping.
 *
 * It writes the payloads verbatim - no reshaping, no field selection. A fixture
 * that has been tidied up cannot catch the mistake it exists to catch.
 */

export const FIXTURE_DIR = "test/fixtures";
export const MARKET_FIXTURE = path.join(FIXTURE_DIR, "gamma-market.json");
export const BOOK_FIXTURE = path.join(FIXTURE_DIR, "clob-book.json");
export const PROVENANCE = path.join(FIXTURE_DIR, "provenance.json");

type Raw = Record<string, unknown>;

/**
 * Pick a market representative of what a scan actually forecasts: binary, with
 * published resolution criteria and both CLOB token ids. Capturing whichever
 * market happens to be first would pin a shape the scanner never sees.
 */
function pickRepresentative(rows: readonly unknown[]): { raw: Raw; tokenId: string } | null {
  for (const row of rows) {
    const raw = row as Raw;
    const market = normalizeMarket(raw);
    if (!market) continue;
    const binary = asBinaryMarket(market);
    if (!binary) continue;
    if (!binary.description.trim()) continue;
    return { raw, tokenId: binary.yesTokenId };
  }
  return null;
}

export async function capture(argv: readonly string[]): Promise<number> {
  const cfg = loadConfig();
  const idFlag = argv.indexOf("--id");
  const wantedId = idFlag === -1 ? null : (argv[idFlag + 1] ?? null);

  const marketsUrl = wantedId
    ? `${cfg.gammaBase}/markets?id=${encodeURIComponent(wantedId)}`
    : `${cfg.gammaBase}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`;

  console.log(`\n  GET ${marketsUrl}`);
  const page = await getJson<unknown>(marketsUrl);
  const rows = Array.isArray(page) ? page : [page];

  const picked = pickRepresentative(rows);
  if (!picked) {
    console.error(
      `\n  Fetched ${rows.length} market(s) but none normalized into a binary market\n` +
        `  with published criteria. Run 'npm run doctor' - it dumps the raw payload\n` +
        `  shape so you can see which field moved.\n`,
    );
    return 1;
  }

  const bookUrl = `${cfg.clobBase}/book?token_id=${encodeURIComponent(picked.tokenId)}`;
  console.log(`  GET ${bookUrl}`);
  const book = await getJson<unknown>(bookUrl);

  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(MARKET_FIXTURE, `${JSON.stringify(picked.raw, null, 2)}\n`);
  await writeFile(BOOK_FIXTURE, `${JSON.stringify(book, null, 2)}\n`);
  await writeFile(
    PROVENANCE,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        marketUrl: marketsUrl,
        bookUrl,
        marketId: String(picked.raw["id"] ?? ""),
        note: "Captured verbatim by `npm run capture`. Do not hand-edit - recapture instead.",
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\n  Wrote ${MARKET_FIXTURE}\n        ${BOOK_FIXTURE}\n        ${PROVENANCE}\n\n` +
      `  Run 'npm test' - the fixture tests now assert against real payloads.\n`,
  );
  return 0;
}
