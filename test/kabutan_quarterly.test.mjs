// kabutan.mjsの四半期・年次データ抽出の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTables, parseQ1Seasonality, parseAnnualRevenueYoY } from '../kabutan.mjs';

test('parseQ1Seasonality: "YY.MM-MM"表記は単四半期(3ヶ月)と中間累計(6ヶ月)を区別する', () => {
  // 実測バグ: 7921で"24.06-11"のような中間累計(6ヶ月)を単四半期(3ヶ月)
  // と誤認し、四半期利益と半期利益を混ぜて平均していた
  // （初期の誤った実装ではavgSharePct=28.4%、修正後は正しく39.8%相当の
  // 値が出ることを確認済み）。ここでは月数を計算で区別できているかを
  // 単純な数値で検証する。
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>24.06-08</td><td>40</td><td>24/10/01</td></tr>
    <tr><td>24.06-11</td><td>999</td><td>24/12/25</td></tr>
    <tr><td>24.09-11</td><td>20</td><td>25/01/10</td></tr>
    <tr><td>24.12-02</td><td>10</td><td>25/04/10</td></tr>
    <tr><td>25.03-05</td><td>30</td><td>25/07/10</td></tr>
    <tr><td>25.06-08</td><td>50</td><td>25/10/01</td></tr>
    <tr><td>25.09-11</td><td>25</td><td>26/01/10</td></tr>
    <tr><td>25.12-02</td><td>15</td><td>26/04/10</td></tr>
    <tr><td>26.03-05</td><td>10</td><td>26/07/10</td></tr>
  </tbody></table>`;
  const tables = parseTables(html);
  const r = parseQ1Seasonality(tables);
  assert.equal(r.years.length, 2);
  assert.equal(r.years[0].annualProfit, 100); // 999(中間累計)が混ざっていたら100にならない
  assert.equal(r.avgSharePct, 45); // (40/100 + 50/100)/2 = 45%
});

test('parseQ1Seasonality: 四半期実績が1年分無ければnull', () => {
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>25.06-08</td><td>50</td><td>25/10/01</td></tr>
    <tr><td>25.09-11</td><td>25</td><td>26/01/10</td></tr>
  </tbody></table>`;
  assert.equal(parseQ1Seasonality(parseTables(html)), null);
});

test('parseAnnualRevenueYoY: 会社予想（「予」始まり）は伸び率計算に使わない', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2024.05</td><td>1,000</td><td>24/07/09</td></tr>
    <tr><td>2025.05</td><td>1,100</td><td>25/07/09</td></tr>
    <tr><td>予 2026.05</td><td>9,999</td><td>25/07/09</td></tr>
  </tbody></table>`;
  const r = parseAnnualRevenueYoY(parseTables(html));
  assert.equal(r.latestPeriod, '2025.05'); // 予想行(2026.05)を最新と誤認しない
  assert.equal(r.growthPct, 10); // (1100-1000)/1000*100
});
