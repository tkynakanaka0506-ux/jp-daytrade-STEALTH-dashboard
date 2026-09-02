// us_edgar.mjs（SEC EDGAR財務データ）の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuarterlyTrend } from '../us_edgar.mjs';

const quarter = (end, start, val) => ({ end, start, val, filed: end });

test('extractQuarterlyTrend: 研究開発費（ResearchAndDevelopmentExpense）を四半期系列に含める（aggressiveInvestmentSignal用。実測: AAPLのcompanyfactsに標準タグとして存在することを確認済み）', () => {
  const facts = {
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [quarter('2025-06-27', '2025-03-28', 1000), quarter('2025-09-27', '2025-06-28', 1200)] },
        },
        ResearchAndDevelopmentExpense: {
          units: { USD: [quarter('2025-06-27', '2025-03-28', 100), quarter('2025-09-27', '2025-06-28', 150)] },
        },
      },
    },
  };
  const trend = extractQuarterlyTrend(facts);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].rnd, 100);
  assert.equal(trend[1].rnd, 150);
});

test('extractQuarterlyTrend: 研究開発費を開示していない企業はrnd:null（推測で埋めない）', () => {
  const facts = {
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [quarter('2025-06-27', '2025-03-28', 1000)] },
        },
      },
    },
  };
  const trend = extractQuarterlyTrend(facts);
  assert.equal(trend[0].rnd, null);
});
