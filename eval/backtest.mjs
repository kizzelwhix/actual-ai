// Offline backtest: hide the category of transactions you categorised yourself,
// ask the model, score against your choice. Never writes to Actual.
//
// Usage: node eval/backtest.mjs <budget.json> <outDir> [--arms a,b,c] [--since YYYY-MM-DD] [--limit N]
// Env:   OLLAMA_URL (default http://127.0.0.1:11434), OLLAMA_MODEL, TEMPERATURE (default 0)
//
// Arms: baseline  upstream prompt as the app renders it today (amount in raw cents)
//       amt       same, amount shown as dollars
//       hNN       amt + history of the same/similar payee from the NN days before the txn
//       majority  no LLM: most common past category for the payee (reference)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const handlebars = require(path.join(root, 'dist/src/handlebars-helpers.js')).default;
const { transformRulesToDescriptions } = require(path.join(root, 'dist/src/utils/rule-utils.js'));
const { parseLlmResponse } = require(path.join(root, 'dist/src/utils/json-utils.js'));
const SimilarityCalculator = require(path.join(root, 'dist/src/similarity-calculator.js')).default;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const [budgetFile, outDir] = args;
if (!budgetFile || !outDir) { console.error('usage: backtest.mjs <budget.json> <outDir> [--arms ...]'); process.exit(2); }
const arms = opt('arms', 'majority,baseline,amt,h30,h60,h90').split(',');
const since = opt('since', '2026-08-01');
const limit = Number(opt('limit', '0'));
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL ?? 'frob/qwen3.5-instruct:4b';
const TEMP = Number(process.env.TEMPERATURE ?? '0');
const MATCH_THRESHOLD = Number(process.env.PAYEE_MATCH_THRESHOLD ?? '0.85');
const HISTORY_SHOW = Number(process.env.HISTORY_SHOW ?? '5');

const d = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
const accounts = new Map(d.accounts.map((a) => [a.id, a]));
const payees = d.payees;
const payeeName = new Map(payees.map((p) => [p.id, p.name]));
const groups = d.categoryGroups.map((g) => ({ ...g, groupName: g.name, categories: g.categories ?? [] }));
const allCats = groups.flatMap((g) => g.categories);
const catName = new Map(allCats.map((c) => [c.id, c.name]));
const rulesDescription = transformRulesToDescriptions(d.rules, allCats, payees);
const sim = new SimilarityCalculator();

const usable = (t) => !t.is_parent && !t.transfer_id && !t.starting_balance_flag
  && !accounts.get(t.account)?.offbudget && (t.payee || t.imported_payee);
const aiTagged = (t) => (t.notes ?? '').includes('#actual-ai');
// Ground truth + history pool: categorised by you, not by actual-ai.
const human = d.transactions.filter((t) => usable(t) && t.category && !aiTagged(t))
  .sort((a, b) => a.date.localeCompare(b.date));
let targets = human.filter((t) => t.date >= since);
if (limit) targets = targets.slice(0, limit);

// --- Rule coverage: would one of your rules have set the category? -------------
const condOk = (c, t) => {
  const v = c.value;
  const s = (x) => String(x ?? '').toLowerCase();
  switch (`${c.field}:${c.op}`) {
    case 'payee:is': return t.payee === v;
    case 'payee:oneOf': return Array.isArray(v) && v.includes(t.payee);
    case 'account:is': return t.account === v;
    case 'imported_payee:is': return s(t.imported_payee) === s(v);
    case 'imported_payee:contains': return s(t.imported_payee).includes(s(v));
    case 'notes:contains': return s(t.notes).includes(s(v));
    case 'notes:is': return s(t.notes) === s(v);
    case 'amount:isbetween': return t.amount >= Math.min(v.num1, v.num2) && t.amount <= Math.max(v.num1, v.num2);
    case 'amount:is': return t.amount === v;
    default: return null; // unknown -> can't tell
  }
};
const ruleCovered = (t) => d.rules.some((r) => {
  if (!r.actions.some((a) => a.op === 'set' && a.field === 'category' && a.value)) return false;
  const res = r.conditions.map((c) => condOk(c, t));
  if (res.includes(null)) return false;
  return r.conditionsOp === 'or' ? res.some(Boolean) : res.every(Boolean);
});

// --- History -----------------------------------------------------------------
const rawPayee = (t) => t.imported_payee || payeeName.get(t.payee) || '';
const samePayee = (a, b) => (a.payee && a.payee === b.payee)
  || (rawPayee(a) && rawPayee(b) && sim.calculateNameSimilarity(rawPayee(a), rawPayee(b)) >= MATCH_THRESHOLD);
const dayMs = 86400000;
function historyFor(t, days) {
  const from = new Date(Date.parse(t.date) - days * dayMs).toISOString().slice(0, 10);
  return human.filter((h) => h.date < t.date && h.date >= from && samePayee(h, t))
    .sort((a, b) => b.date.localeCompare(a.date));
}
const dollars = (cents) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// --- Prompt ------------------------------------------------------------------
const baseTemplate = fs.readFileSync(path.join(root, 'src/templates/prompt.hbs'), 'utf8');
const historyBlock = `{{#if history.length}}

My past transactions with this payee (most recent first):
{{#each history}}
* {{date}}: {{amount}} → {{categoryName}} (ID: "{{categoryId}}")
{{/each}}
Summary: {{historySummary}}
I am usually consistent per payee: prefer the category I used before unless this transaction is clearly different.
{{/if}}
`;
const historyTemplate = baseTemplate.replace('\nExisting categories by group:', `${historyBlock}\nExisting categories by group:`);
if (historyTemplate === baseTemplate) throw new Error('could not insert history block');
const compiled = { base: handlebars.compile(baseTemplate), hist: handlebars.compile(historyTemplate) };

function render(t, arm) {
  const ctx = {
    categoryGroups: groups,
    rules: rulesDescription,
    amount: arm === 'baseline' ? Math.abs(t.amount) : dollars(t.amount),
    type: t.amount > 0 ? 'Income' : 'Outcome',
    description: t.notes ?? '',
    payee: payeeName.get(t.payee) ?? '',
    importedPayee: t.imported_payee ?? '',
    date: t.date ?? '',
    hasWebSearchTool: false,
  };
  const m = arm.match(/^h(\d+)$/);
  if (!m) return compiled.base(ctx);
  const hist = historyFor(t, Number(m[1]));
  const counts = {};
  for (const h of hist) counts[h.category] = (counts[h.category] ?? 0) + 1;
  ctx.history = hist.slice(0, HISTORY_SHOW).map((h) => ({
    date: h.date, amount: dollars(h.amount), categoryId: h.category, categoryName: catName.get(h.category) ?? '?',
  }));
  ctx.historySummary = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${catName.get(c) ?? '?'} ×${n}`).join(', ');
  return compiled.hist(ctx);
}

async function ask(prompt) {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, stream: false, keep_alive: '10m',
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: TEMP },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const j = await r.json();
  return { text: j.message?.content ?? '', promptTokens: j.prompt_eval_count, ms: Date.now() - t0 };
}

function predict(text) {
  try {
    const p = parseLlmResponse(text);
    if (p.type === 'new') return { kind: 'new' };
    if (p.categoryId && catName.has(p.categoryId)) return { kind: p.type, categoryId: p.categoryId };
    return { kind: p.categoryId ? 'bad-id' : 'no-category' };
  } catch { return { kind: 'parse-error' }; }
}

// --- Run ---------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const meta = targets.map((t) => ({
  id: t.id, truth: t.category, ruleCovered: ruleCovered(t), seenBefore: historyFor(t, 100000).length > 0,
}));
console.log(`targets ${targets.length} since ${since}; rule-covered ${meta.filter((m) => m.ruleCovered).length}; repeat payee ${meta.filter((m) => m.seenBefore).length}`);

const results = {};
for (const arm of arms) {
  const rows = [];
  for (const [i, t] of targets.entries()) {
    let row;
    if (arm === 'majority') {
      const h = historyFor(t, 100000);
      const c = {};
      for (const x of h) c[x.category] = (c[x.category] ?? 0) + 1;
      const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
      row = { kind: best ? 'majority' : 'none', categoryId: best };
    } else {
      const prompt = render(t, arm);
      try {
        const r = await ask(prompt);
        row = { ...predict(r.text), promptTokens: r.promptTokens, ms: r.ms };
      } catch (e) { row = { kind: 'llm-error', error: String(e.message) }; }
    }
    row.correct = row.categoryId === t.category;
    rows.push({ ...meta[i], ...row });
    if (arm !== 'majority' && (i + 1) % 25 === 0) console.log(`  ${arm} ${i + 1}/${targets.length}`);
  }
  results[arm] = rows;
  fs.writeFileSync(path.join(outDir, `rows-${arm}.json`), JSON.stringify(rows), { mode: 0o600 });
  const pct = (xs) => (xs.length ? `${((100 * xs.filter((x) => x.correct).length) / xs.length).toFixed(1)}% (${xs.filter((x) => x.correct).length}/${xs.length})` : '-');
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const tok = rows.filter((r) => r.promptTokens);
  console.log([
    `${arm.padEnd(9)} all ${pct(rows)}`,
    `repeat ${pct(rows.filter((r) => r.seenBefore))}`,
    `new ${pct(rows.filter((r) => !r.seenBefore))}`,
    `no-rule ${pct(rows.filter((r) => !r.ruleCovered))}`,
    tok.length ? `tokens avg ${Math.round(tok.reduce((s, r) => s + r.promptTokens, 0) / tok.length)} max ${Math.max(...tok.map((r) => r.promptTokens))}` : '',
    tok.length ? `ms avg ${Math.round(tok.reduce((s, r) => s + r.ms, 0) / tok.length)}` : '',
    JSON.stringify(kinds),
  ].filter(Boolean).join(' | '));
}
