import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDisplay, budgetStored, formatMoney } from '../public/money.js';
import { validateLimits } from '../lib/store.mjs';

test('ruble budgets round-trip without changing stored USD quota semantics', () => {
  const billing = { currency: 'RUB', rubPerUSD: 84.4283 };
  for (const rubles of [0.85, 10, 100, 5000, 84428.30]) {
    const usd = budgetStored(rubles, billing);
    validateLimits({ dailyUSD: usd }, true);
    assert.equal(budgetDisplay(usd, billing), rubles);
    assert.ok(usd * billing.rubPerUSD >= rubles - 1e-9);
  }
  assert.match(formatMoney(33.25 / 84.4283, billing), /33,25.*₽/);
  assert.match(formatMoney(166 / 84.4283, billing), /166,00.*₽/);
  assert.equal(budgetStored(100), 100);
  assert.match(formatMoney(1), /1,00.*\$/);
  assert.throws(() => validateLimits({dailyUSD: budgetStored(0.01, billing)}, true));
});
