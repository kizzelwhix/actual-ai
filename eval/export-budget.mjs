// Read-only export of an Actual budget for offline backtesting.
// Usage: node eval/export-budget.mjs <outDir> [envFile]
// Env: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_BUDGET_ID[, ACTUAL_E2E_PASSWORD]
// envFile (optional) is parsed like Docker's env_file: KEY=VALUE, value taken
// literally (spaces included). Never `source` it from a shell.
// Calls no mutating API. Output contains real financial data: keep it out of git.
import api from '@actual-app/api';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (process.argv[3]) {
  for (const line of fs.readFileSync(process.argv[3], 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
if (!out) { console.error('usage: export-budget.mjs <outDir>'); process.exit(2); }
const dataDir = path.join(out, 'actual-data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

await api.init({ dataDir, serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_PASSWORD });
try {
  const e2e = process.env.ACTUAL_E2E_PASSWORD;
  await api.downloadBudget(process.env.ACTUAL_BUDGET_ID, e2e ? { password: e2e } : undefined);
  const accounts = await api.getAccounts();
  const transactions = [];
  for (const a of accounts) {
    transactions.push(...await api.getTransactions(a.id, '1990-01-01', '2100-01-01'));
  }
  const dump = {
    exportedAt: new Date().toISOString(),
    accounts,
    transactions,
    categoryGroups: await api.getCategoryGroups(),
    categories: await api.getCategories(),
    payees: await api.getPayees(),
    rules: await api.getRules(),
  };
  const f = path.join(out, 'budget.json');
  fs.writeFileSync(f, JSON.stringify(dump), { mode: 0o600 });
  console.log(`wrote ${f}: ${transactions.length} transactions, ${accounts.length} accounts`);
} finally {
  await api.shutdown();
}
