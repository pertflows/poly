import { mkdir, writeFile } from "node:fs/promises";

import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { getJson } from "../polymarket/http.ts";

/**
 * Render the paper-trading ledger as a single self-contained HTML page.
 *
 * Open positions are marked to the live market price so the balance reflects
 * what the book is worth right now, not what it cost. Realized and unrealized
 * P&L are kept apart on purpose: in a one-week run almost nothing has resolved,
 * and a single number blending "we were paid" with "we are currently ahead"
 * would flatter the result exactly when it is least earned.
 */

interface Row { [k: string]: unknown }

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

async function livePrice(cfg: ReturnType<typeof loadConfig>, marketId: string): Promise<number | null> {
  try {
    const raw = await getJson<unknown>(`${cfg.gammaBase}/markets?id=${encodeURIComponent(marketId)}`);
    const row = (Array.isArray(raw) ? raw[0] : raw) as Row | undefined;
    if (!row) return null;
    const prices = row["outcomePrices"];
    const list = typeof prices === "string" ? (JSON.parse(prices) as unknown[]) : prices;
    if (!Array.isArray(list) || list.length === 0) return null;
    const yes = Number(list[0]);
    return Number.isFinite(yes) ? yes : null;
  } catch {
    return null;
  }
}

export async function dashboard(argv: readonly string[]): Promise<number> {
  const cfg = loadConfig();
  const out = argv.includes("--out") ? (argv[argv.indexOf("--out") + 1] ?? "dashboard.html") : "dashboard.html";
  const db = openDb(cfg.dbPath);

  const open = db.prepare(
    `SELECT p.*, f.end_date FROM positions p
       LEFT JOIN forecasts f ON f.id = p.forecast_id
      WHERE p.status='open' ORDER BY p.opened_at DESC`).all() as Row[];
  const closed = db.prepare(
    `SELECT p.*, f.end_date FROM positions p
       LEFT JOIN forecasts f ON f.id = p.forecast_id
      WHERE p.status!='open' ORDER BY p.settled_at DESC`).all() as Row[];
  const forecasts = db.prepare(
    `SELECT question, probability, market_probability, confidence, abstain, stale_knowledge,
            resolution_reading, key_drivers, evidence_for, evidence_against, base_rate,
            end_date, created_at, cost_usd
       FROM forecasts ORDER BY id DESC LIMIT 12`).all() as Row[];
  const spend = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM forecasts").get() as Row)["c"] as number;
  const nForecasts = (db.prepare("SELECT COUNT(*) AS n FROM forecasts").get() as Row)["n"] as number;

  // Mark open positions to the live book.
  let openCost = 0, openValue = 0, openPayout = 0;
  const openRows: string[] = [];
  for (const p of open) {
    const stake = Number(p["stake_usd"]), contracts = Number(p["contracts"]);
    const side = String(p["side"]), entry = Number(p["entry_price"]);
    const yes = await livePrice(cfg, String(p["market_id"]));
    const now = yes === null ? null : side.toUpperCase() === "YES" ? yes : 1 - yes;
    const value = now === null ? stake : contracts * now;
    openCost += stake; openValue += value; openPayout += contracts;
    const d = value - stake;
    const end = String(p["end_date"] ?? "").slice(0, 10);
    const daysLeft = end ? Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000) : null;
    openRows.push(`<tr data-mkt="${esc(p["market_id"])}">
      <td class="q">${esc(p["question"])}</td>
      <td><span class="side ${esc(side.toLowerCase())}">${esc(side)}</span></td>
      <td class="n">${entry.toFixed(3)}</td>
      <td class="n now">${now === null ? "&mdash;" : now.toFixed(3)}</td>
      <td class="n">${contracts.toFixed(1)}</td>
      <td class="n">${usd(stake)}</td>
      <td class="n unreal ${d >= 0 ? "up" : "down"}">${usd(d)}</td>
      <td class="n"><strong>${usd(contracts)}</strong> <span class="muted">(+${usd(contracts - stake)})</span></td>
      <td class="n muted odds">${now === null ? "&mdash;" : pct(now)}</td>
      <td class="n">${end ? `${end}<br><span class="muted">${daysLeft !== null && daysLeft >= 0 ? `${daysLeft}d left` : "closing"}</span>` : "&mdash;"}</td></tr>`);
  }

  // Payload the browser re-prices against. Polymarket serves
  // access-control-allow-origin:* on both APIs, so the page can poll live
  // prices itself with no backend. Where that fetch is blocked (the artifact
  // viewer's CSP forbids it) the page keeps these snapshot values instead of
  // rendering blanks.
  const livePayload = JSON.stringify(open.map((p) => ({
    id: String(p["market_id"]),
    side: String(p["side"]).toUpperCase(),
    contracts: Number(p["contracts"]),
    stake: Number(p["stake_usd"]),
  })));

  const realized = closed.reduce((a, p) => a + Number(p["pnl_usd"] ?? 0), 0);
  const wins = closed.filter((p) => Number(p["pnl_usd"] ?? 0) > 0).length;
  const unrealized = openValue - openCost;
  const cash = cfg.trade.bankroll - openCost + realized;
  const equity = cash + openValue;

  const closedRows = closed.map((p) => {
    const pnl = Number(p["pnl_usd"] ?? 0);
    return `<tr>
      <td class="q">${esc(p["question"])}</td>
      <td><span class="side ${esc(String(p["side"]).toLowerCase())}">${esc(p["side"])}</span></td>
      <td class="n">${Number(p["entry_price"]).toFixed(3)}</td>
      <td class="n">${usd(Number(p["stake_usd"]))}</td>
      <td class="n">${p["outcome"] === 1 ? "YES" : "NO"}</td>
      <td class="n ${pnl >= 0 ? "up" : "down"}"><strong>${usd(pnl)}</strong></td>
      <td class="n muted">${esc(String(p["settled_at"] ?? "").slice(0, 10))}</td></tr>`;
  }).join("");

  const thinking = forecasts.map((f) => {
    const claude = Number(f["probability"]), market = Number(f["market_probability"]);
    const gap = (claude - market) * 100;
    const abstained = Number(f["abstain"]) === 1;
    const tags = [
      abstained ? `<span class="tag warn">abstained</span>` : "",
      Number(f["stale_knowledge"]) === 1 ? `<span class="tag">stale knowledge</span>` : "",
      `<span class="tag">${esc(f["confidence"])} confidence</span>`,
    ].join("");
    return `<article class="card">
      <h3>${esc(f["question"])}</h3>
      <div class="nums">
        <span>Claude <strong>${pct(claude)}</strong></span>
        <span class="muted">Market <strong>${pct(market)}</strong></span>
        <span class="${gap >= 0 ? "up" : "down"}">Gap <strong>${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp</strong></span>
      </div>
      <div class="tags">${tags}</div>
      ${f["resolution_reading"] ? `<p><span class="lbl">Reads the criteria as</span> ${esc(f["resolution_reading"])}</p>` : ""}
      ${f["base_rate"] ? `<p><span class="lbl">Base rate</span> ${esc(f["base_rate"])}</p>` : ""}
      ${f["evidence_for"] ? `<p><span class="lbl">For</span> ${esc(f["evidence_for"])}</p>` : ""}
      ${f["evidence_against"] ? `<p><span class="lbl">Against</span> ${esc(f["evidence_against"])}</p>` : ""}
      <div class="foot muted">resolves ${esc(String(f["end_date"] ?? "").slice(0, 10))} &middot; forecast ${esc(String(f["created_at"] ?? "").slice(0, 10))} &middot; cost ${usd(Number(f["cost_usd"] ?? 0))}</div>
    </article>`;
  }).join("");

  const html = `<title>Poly Paper Desk</title>
<style>
  :root{--bg:#fbfaf9;--panel:#fff;--ink:#1a1a19;--muted:#6b6b68;--line:#e5e3e0;
        --up:#0f7a4d;--down:#b3261e;--accent:#4a5d7e;--warn:#8a6d1f;--chip:#f0eeec}
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){
        --bg:#16161a;--panel:#1e1e23;--ink:#eceaea;--muted:#9a9a99;--line:#32323a;
        --up:#4ade80;--down:#f87171;--accent:#9db2d8;--warn:#d4b95e;--chip:#2a2a31}}
  :root[data-theme=dark]{--bg:#16161a;--panel:#1e1e23;--ink:#eceaea;--muted:#9a9a99;
        --line:#32323a;--up:#4ade80;--down:#f87171;--accent:#9db2d8;--warn:#d4b95e;--chip:#2a2a31}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 64px;background:var(--bg);color:var(--ink);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1120px;margin:0 auto}
  h1{font-size:22px;margin:0 0 2px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:13px;margin-bottom:24px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:28px}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .kpi .lab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .kpi .val{font-size:25px;font-variant-numeric:tabular-nums;margin-top:5px;letter-spacing:-.02em}
  .kpi .note{font-size:12px;color:var(--muted);margin-top:2px}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
     margin:32px 0 10px;font-weight:600}
  .scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;min-width:720px;font-size:14px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
     color:var(--muted);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line)}
  td{padding:10px 12px;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:none}
  .q{max-width:340px}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .up{color:var(--up)} .down{color:var(--down)} .muted{color:var(--muted)}
  .side{font-size:11px;font-weight:600;padding:2px 7px;border-radius:4px;background:var(--chip)}
  .side.yes{color:var(--up)} .side.no{color:var(--down)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 17px}
  .card h3{font-size:15px;margin:0 0 9px;line-height:1.35;letter-spacing:-.01em}
  .nums{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;font-variant-numeric:tabular-nums;
        padding-bottom:9px;border-bottom:1px solid var(--line)}
  .tags{margin:9px 0}
  .tag{display:inline-block;font-size:11px;background:var(--chip);color:var(--muted);
       padding:2px 7px;border-radius:4px;margin-right:5px}
  .tag.warn{color:var(--warn)}
  .card p{margin:7px 0;font-size:13px;color:var(--ink)}
  .lbl{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;
       color:var(--muted);margin-bottom:1px}
  .foot{font-size:11px;margin-top:11px;padding-top:9px;border-top:1px solid var(--line)}
  .empty{background:var(--panel);border:1px dashed var(--line);border-radius:10px;
         padding:22px;color:var(--muted);font-size:14px}
  .pill{display:inline-block;font-size:11px;background:var(--chip);color:var(--muted);
        padding:2px 8px;border-radius:99px;font-variant-numeric:tabular-nums}
  .pill.live{color:var(--up)}
  .banner{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
          border-radius:8px;padding:11px 14px;font-size:13px;color:var(--muted);margin-bottom:22px}
</style>
<div class="wrap" data-cash="${cash.toFixed(4)}">
  <h1>Poly Paper Desk</h1>
  <div class="sub">Simulated positions only &middot; no money can move &middot;
    <span id="status" class="pill">snapshot ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC</span></div>

  <div class="banner">Open positions are marked to the live market price. Realized P&amp;L counts only
  resolved markets &mdash; most questions here run 2&ndash;120 days, so early on nearly everything sits unrealized.</div>

  <div class="kpis">
    <div class="kpi"><div class="lab">Equity</div><div class="val" id="kpi-equity">${usd(equity)}</div>
      <div class="note">from ${usd(cfg.trade.bankroll)} start</div></div>
    <div class="kpi"><div class="lab">Cash</div><div class="val">${usd(cash)}</div>
      <div class="note">${usd(openCost)} deployed</div></div>
    <div class="kpi"><div class="lab">Unrealized</div><div class="val ${unrealized >= 0 ? "up" : "down"}" id="kpi-unreal">${usd(unrealized)}</div>
      <div class="note">${open.length} open</div></div>
    <div class="kpi"><div class="lab">Realized</div><div class="val ${realized >= 0 ? "up" : "down"}">${usd(realized)}</div>
      <div class="note">${closed.length} settled${closed.length ? ` &middot; ${wins}W ${closed.length - wins}L` : ""}</div></div>
    <div class="kpi"><div class="lab">If all open win</div><div class="val up">${usd(openPayout)}</div>
      <div class="note">on ${usd(openCost)} staked &middot; +${usd(openPayout - openCost)}</div></div>
    <div class="kpi"><div class="lab">Model spend</div><div class="val">${usd(spend)}</div>
      <div class="note">${nForecasts} forecasts &middot; real dollars</div></div>
  </div>

  <h2>Open positions</h2>
  ${open.length ? `<div class="scroll"><table>
    <tr><th>Market</th><th>Side</th><th class="n">Entry</th><th class="n">Now</th><th class="n">Contracts</th><th class="n">Stake</th><th class="n">Unrealized</th><th class="n">If it wins</th><th class="n">Odds now</th><th class="n">Closes</th></tr>
    ${openRows.join("")}</table></div>`
   : `<div class="empty">No open positions. The bot only takes one when its probability differs from the market by more than the minimum edge.</div>`}

  <h2>Settled</h2>
  ${closed.length ? `<div class="scroll"><table>
    <tr><th>Market</th><th>Side</th><th class="n">Entry</th><th class="n">Stake</th><th class="n">Resolved</th><th class="n">P&amp;L</th><th class="n">Settled</th></tr>
    ${closedRows}</table></div>`
   : `<div class="empty">Nothing has resolved yet.</div>`}

  <h2>What it is thinking</h2>
  ${forecasts.length ? `<div class="cards">${thinking}</div>`
   : `<div class="empty">No forecasts recorded yet.</div>`}
</div>
<script>
(function(){
  var POS = ${livePayload};
  var el = function(s,r){return (r||document).querySelector(s)};
  var money = function(n){return (n<0?"-":"")+"$"+Math.abs(n).toFixed(2)};
  var status = el("#status");
  if(!POS.length){ if(status) status.textContent="no open positions"; return; }

  function yesPrice(m){
    try{
      var p = typeof m.outcomePrices==="string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      var v = parseFloat(p[0]);
      return isFinite(v) ? v : null;
    }catch(e){ return null; }
  }

  function paint(prices){
    var cost=0, value=0, live=0;
    POS.forEach(function(p){
      var yes = prices[p.id];
      var now = yes===null||yes===undefined ? null : (p.side==="YES" ? yes : 1-yes);
      var val = now===null ? p.stake : p.contracts*now;
      cost += p.stake; value += val;
      if(now!==null) live++;
      var row = el('tr[data-mkt="'+p.id+'"]');
      if(!row || now===null) return;
      var d = val - p.stake;
      var c;
      if((c=el(".now",row)))    c.textContent = now.toFixed(3);
      if((c=el(".odds",row)))   c.textContent = (now*100).toFixed(1)+"%";
      if((c=el(".unreal",row))){ c.textContent = money(d);
        c.className = "n unreal " + (d>=0?"up":"down"); }
    });
    var unreal = value - cost;
    var w = el(".wrap"); var base = parseFloat((w && w.dataset.cash) || "0");
    var k;
    if((k=el("#kpi-unreal"))){ k.textContent = money(unreal);
      k.className = "val " + (unreal>=0?"up":"down"); }
    if((k=el("#kpi-equity"))) k.textContent = money(base + value);
    if(status){
      status.textContent = "live · " + live + "/" + POS.length + " priced · " +
        new Date().toLocaleTimeString();
      status.className = "pill live";
    }
  }

  function tick(){
    Promise.all(POS.map(function(p){
      return fetch("https://gamma-api.polymarket.com/markets?id="+encodeURIComponent(p.id))
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          var m = Array.isArray(j) ? j[0] : j;
          return [p.id, m ? yesPrice(m) : null];
        })
        .catch(function(){ return [p.id, null]; });
    })).then(function(pairs){
      var prices={}, any=false;
      pairs.forEach(function(kv){ prices[kv[0]]=kv[1]; if(kv[1]!==null) any=true; });
      if(any) paint(prices);
      else if(status) status.textContent = "snapshot · live prices unavailable here";
    }).catch(function(){
      if(status) status.textContent = "snapshot · live prices unavailable here";
    });
  }

  tick();
  setInterval(tick, 20000);
  document.addEventListener("visibilitychange", function(){ if(!document.hidden) tick(); });
})();
</script>`;

  await writeFile(out, html);
  // Vercel serves web/ as a static site; the page polls Polymarket itself, so
  // the deploy needs no backend. The nightly push is what refreshes it.
  await mkdir("web", { recursive: true });
  await writeFile("web/index.html", html);
  db.close();
  console.log(`\n  Wrote ${out}\n  equity ${usd(equity)} | ${open.length} open | ${closed.length} settled | model spend ${usd(spend)}\n`);
  return 0;
}
