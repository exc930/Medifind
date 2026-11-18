// MediFind: refresh official FDA label info for every medicine.
// Runs on GitHub every week (see .github/workflows/refresh-official.yml). No setup needed to run it;
// an optional free openFDA key (GitHub secret OPENFDA_API_KEY) lets it check everything in one go.
//
// For each generic name in tools/generics.json it asks openFDA for the newest matching drug label and saves:
//   s = label id (opens the exact label on DailyMed)   d = date the FDA label was last updated
//   b = boxed warning text, if the label has one        u = date we noticed the label changed
// Results go in official.json, which the app reads.

import fs from "node:fs";

const KEY = process.env.OPENFDA_API_KEY || "";
const MAX = KEY ? 100000 : 900;          // without a key openFDA allows ~1,000 lookups a day
const WAIT = +process.env.WAIT || (KEY ? 120 : 300);            // stay under openFDA's 240 lookups a minute
const gens = JSON.parse(fs.readFileSync("tools/generics.json", "utf8"));
let off = { updated: null, labels: {}, checked: {} };
try { off = JSON.parse(fs.readFileSync("official.json", "utf8")); } catch (e) {}
off.labels ||= {}; off.checked ||= {};

const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parts = g => g.split(";").map(x => x.trim().replace(/["\\]/g, "")).filter(Boolean);
const count = gn => gn.split(/,| and /i).map(x => x.trim()).filter(Boolean).length;

async function lookup(g) {
  const p = parts(g);
  const search = p.map(x => `openfda.generic_name:"${x}"`).join(" AND ");
  const url = "https://api.fda.gov/drug/label.json?search=" + encodeURIComponent(search).replace(/%20/g, "+") + "&limit=20" + (KEY ? "&api_key=" + KEY : "");
  for (let t = 0; t < 4; t++) {
    let r;
    try { r = await fetch(url); } catch (e) { await sleep(3000); continue; }
    if (r.status === 404) return null;                       // no label found
    if (r.status === 429) { await sleep(process.env.WAIT ? 1 : 30000 * (t + 1)); continue; }   // too many requests: wait
    if (!r.ok) { await sleep(3000); continue; }
    const j = await r.json();
    const res = (j.results || []).map(x => {
      const gn = ((x.openfda && x.openfda.generic_name) || [""])[0];
      return { x, score: (count(gn) === p.length ? 2 : 0) + (x.boxed_warning ? 0 : 0), date: x.effective_time || "0" };
    }).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
    return res.length ? res[0].x : null;
  }
  return undefined;                                          // could not reach openFDA
}

const order = gens.slice().sort((a, b) => (off.checked[a] || "0").localeCompare(off.checked[b] || "0"));
let done = 0, found = 0, changed = 0, failed = 0;
for (const g of order) {
  if (done >= MAX) break;
  const x = await lookup(g); done++;
  if (x === undefined) { failed++; await sleep(WAIT); continue; }
  off.checked[g] = today;
  if (x === null) { delete off.labels[g]; await sleep(WAIT); continue; }
  found++;
  const prev = off.labels[g] || {};
  const bw = (x.boxed_warning || []).join(" ").replace(/\s+/g, " ").replace(/^(boxed warning|warning)[:.\s]*/i, "").trim();
  const next = { s: x.set_id, d: x.effective_time };
  if (bw) next.b = bw.length > 900 ? bw.slice(0, 900).replace(/\s\S*$/, "") + "…" : bw;
  if (prev.d && prev.d !== next.d) { next.u = today; changed++; } else if (prev.u) next.u = prev.u;
  off.labels[g] = next;
  await sleep(WAIT);
}

console.log(`Checked ${done} medicines: ${found} matched an FDA label, ${changed} labels changed, ${failed} could not be reached.`);
if (done && failed > done / 2) { console.error("openFDA could not be reached for most medicines; keeping the old file."); process.exit(1); }
off.updated = today;
fs.writeFileSync("official.json", JSON.stringify(off));
