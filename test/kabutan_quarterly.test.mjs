// kabutan.mjsの四半期・年次データ抽出の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTables, parseQ1Seasonality, parseAnnualRevenueYoY, parseProgressHistory, parseAnnualOperatingProfitForecastYoY,
  parseLatestQuarterlyOperatingProfitYoY, parseYoyCell, periodSpanMonths, parseCheckpointTrend, parseNextMilestoneForecast,
  parseLatestDebtEquityRatio,
} from '../kabutan.mjs';

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
  assert.equal(r.prevGrowthPct, null); // 2期分しかないので加速判定はできない
});

test('parseAnnualRevenueYoY: 3期分あれば前期のYoY成長率もprevGrowthPctとして返す（成長の「加速」判定用）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2023.05</td><td>1,000</td><td>23/07/09</td></tr>
    <tr><td>2024.05</td><td>1,100</td><td>24/07/09</td></tr>
    <tr><td>2025.05</td><td>1,430</td><td>25/07/09</td></tr>
  </tbody></table>`;
  const r = parseAnnualRevenueYoY(parseTables(html));
  assert.equal(r.prevGrowthPct, 10); // (1100-1000)/1000*100 = 前期のYoY
  assert.equal(r.growthPct, 30); // (1430-1100)/1100*100 = 直近期のYoY（加速）
});

// 「業績屈折(INFLECTION)」セクション向け。parseAnnualRevenueYoYとは逆に
// 「予」始まりの会社予想行を主役として使う（実績→予想のYoYを見たい）。
// 実データ(250Aシマダヤ)で確認済み: 2026.03実績3,768→2027.03予想3,700
// （表記は「連 2026.03」「連 予 2027.03」のように「連」接頭辞が付く）。
test('parseAnnualOperatingProfitForecastYoY: 実績→会社予想のYoYを返す（実データ形式の「連」接頭辞付き）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>連 2025.03</td><td>3,372</td><td>25/05/12</td></tr>
    <tr><td>連 2026.03</td><td>3,768</td><td>26/05/12</td></tr>
    <tr><td>連 予 2027.03</td><td>3,700</td><td>26/05/12</td></tr>
  </tbody></table>`;
  const r = parseAnnualOperatingProfitForecastYoY(parseTables(html));
  assert.equal(r.actualPeriod, '2026.03');
  assert.equal(r.actualOpProfit, 3768);
  assert.equal(r.forecastPeriod, '2027.03');
  assert.equal(r.forecastOpProfit, 3700);
  assert.equal(r.yoyPct, -1.8);
  assert.equal(r.turnsProfitable, false);
});

test('parseAnnualOperatingProfitForecastYoY: 前期が赤字だとyoyPctは符号が意味不明になるためnullにし、黒字転換はturnsProfitableで別に示す', () => {
  // 実測バグの再発防止: 前期赤字(-215)→予想黒字(+350)を単純な変化率で
  // 計算すると-262.8%という「悪化」に見えてしまう（実際は黒字転換という
  // 最良のケース）。operatingCfGrowthPct等の既存関数と同じガードを適用する。
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2025.11</td><td>-215</td><td>25/12/25</td></tr>
    <tr><td>予 2026.11</td><td>350</td><td>25/12/25</td></tr>
  </tbody></table>`;
  const r = parseAnnualOperatingProfitForecastYoY(parseTables(html));
  assert.equal(r.actualOpProfit, -215);
  assert.equal(r.forecastOpProfit, 350);
  assert.equal(r.yoyPct, null);
  assert.equal(r.turnsProfitable, true);
});

test('parseAnnualOperatingProfitForecastYoY: 会社予想の行が無ければnullを返す', () => {
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2025.03</td><td>3,372</td><td>25/05/12</td></tr>
    <tr><td>2026.03</td><td>3,768</td><td>26/05/12</td></tr>
  </tbody></table>`;
  assert.equal(parseAnnualOperatingProfitForecastYoY(parseTables(html)), null);
});

// 実測（250Aシマダヤで検証）: latestProfitYoyPct(progressHistory)は
// 新規上場・直近進捗率未公表の銘柄でデータ不足になり計算不能だった。
// 決算期テーブル自身の「前年同期比」行を直接読む方が確実。
test('parseLatestQuarterlyOperatingProfitYoY: 「前年同期比」行から直近四半期の営業益YoYを返す（実データ形式: 250Aシマダヤ相当）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>対上期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>24.04-06*</td><td>10,351</td><td>1,145</td><td>1,183</td><td>841</td><td>55.3</td><td>43.2</td><td>－</td></tr>
    <tr><td>25.04-06</td><td>10,749</td><td>1,045</td><td>1,066</td><td>742</td><td>48.8</td><td>37.7</td><td>25/08/12</td></tr>
    <tr><td>26.04-06</td><td>10,857</td><td>825</td><td>840</td><td>593</td><td>41.5</td><td>－</td><td>26/08/10</td></tr>
    <tr><td>前年同期比</td><td>+1.0</td><td>-21.1</td><td>-21.2</td><td>-20.1</td><td>-15.1</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseLatestQuarterlyOperatingProfitYoY(parseTables(html));
  assert.equal(r.period, '26.04-06');
  assert.equal(r.opProfitYoyPct, -21.1);
});

test('parseLatestQuarterlyOperatingProfitYoY: 「N倍」表記（急変時にkabutanが%の代わりに使う別形式）はnullにする（推測しない）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>対上期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>25.03-05</td><td>14,802</td><td>1,689</td><td>1,698</td><td>767</td><td>16.4</td><td>43.4</td><td>25/07/15</td></tr>
    <tr><td>26.03-05</td><td>16,899</td><td>3,166</td><td>3,210</td><td>1,984</td><td>42.3</td><td>69.8</td><td>26/07/15</td></tr>
    <tr><td>前年同期比</td><td>+14.2</td><td>2.6倍</td><td>+89.0</td><td>2.6倍</td><td>2.6倍</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseLatestQuarterlyOperatingProfitYoY(parseTables(html));
  assert.equal(r, null);
});

test('parseLatestQuarterlyOperatingProfitYoY: 「前年同期比」行が無ければnullを返す', () => {
  const html = `<table><thead><tr><th>決算期</th><th>営業益</th><th>発表日</th></tr></thead><tbody>
    <tr><td>25.04-06</td><td>1,045</td><td>25/08/12</td></tr>
  </tbody></table>`;
  assert.equal(parseLatestQuarterlyOperatingProfitYoY(parseTables(html)), null);
});

test('parseProgressHistory: 同時期(対上期進捗率)の複数年推移を古い→新しい順で返す（実測: 6336石井表記の実データ形式）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>対上期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>24.02-04</td><td>3,190</td><td>50</td><td>100</td><td>75</td><td>9.3</td><td>19.8</td><td>24/06/11</td></tr>
    <tr><td>25.02-04</td><td>3,604</td><td>184</td><td>194</td><td>162</td><td>20.0</td><td>37.2</td><td>25/06/12</td></tr>
    <tr><td>26.02-04</td><td>4,049</td><td>367</td><td>376</td><td>266</td><td>33.4</td><td>91.7</td><td>26/06/09</td></tr>
  </tbody></table>`;
  const history = parseProgressHistory(parseTables(html));
  assert.deepEqual(history.map((h) => h.progress), [19.8, 37.2, 91.7]);
  assert.equal(history[0].period, '24.02-04');
  assert.equal(history.at(-1).label, '対上期進捗率');
  // ユーザー提案「進捗率の横にYoY利益成長率を添える」用に経常益も同じ行から拾う
  assert.deepEqual(history.map((h) => h.profit), [100, 194, 376]);
});

test('parseProgressHistory: 経常益列が無いテーブル（IFRS等）ではprofit:nullのまま進捗率だけ返す', () => {
  const html = `<table><thead><tr><th>決算期</th><th>進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>25.02-04</td><td>30</td><td>25/06/12</td></tr>
  </tbody></table>`;
  const history = parseProgressHistory(parseTables(html));
  assert.equal(history[0].profit, null);
});

test('parseProgressHistory: 会社予想（「予」始まり）は除外する', () => {
  const html = `<table><thead><tr><th>決算期</th><th>進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>25.02-04</td><td>30</td><td>25/06/12</td></tr>
    <tr><td>予26.02-04</td><td>999</td><td>-</td></tr>
  </tbody></table>`;
  const history = parseProgressHistory(parseTables(html));
  assert.equal(history.length, 1);
  assert.equal(history[0].progress, 30);
});

test('parseProgressHistory: 該当テーブルが無ければ空配列', () => {
  assert.deepEqual(parseProgressHistory(parseTables('<table><tr><td>x</td></tr></table>')), []);
});

// ==================================================================
// SECTION D新スペック（ユーザー提案2026-09-12）向けの拡張抽出。
// ==================================================================

test('parseYoyCell: 通常の±X.X%はそのまま数値化する', () => {
  assert.deepEqual(parseYoyCell('+8.8'), { pct: 8.8, state: 'numeric' });
  assert.deepEqual(parseYoyCell('-34.1'), { pct: -34.1, state: 'numeric' });
});

test('parseYoyCell: 「黒転」（赤字→黒字転換）を専用stateで区別する（数値化してnullと混同しない）', () => {
  assert.deepEqual(parseYoyCell('黒転'), { pct: null, state: 'turned_profitable' });
});

test('parseYoyCell: 「赤縮」（赤字幅縮小）・「N倍」（急拡大）も区別する', () => {
  assert.deepEqual(parseYoyCell('赤縮'), { pct: null, state: 'loss_narrowing' });
  assert.deepEqual(parseYoyCell('2.6倍'), { pct: 160, state: 'multiple' }); // (2.6-1)*100
});

test('parseYoyCell: 「－」・空文字はデータ無し(none)、それ以外の未知表記はunknown（推測しない）', () => {
  assert.deepEqual(parseYoyCell('－'), { pct: null, state: 'none' });
  assert.deepEqual(parseYoyCell(''), { pct: null, state: 'none' });
  assert.deepEqual(parseYoyCell('謎表記'), { pct: null, state: 'unknown' });
});

test('periodSpanMonths: "MM-MM"形式の月数を判定する（四半期=3ヶ月・中間期=6ヶ月・年またぎも対応）', () => {
  assert.equal(periodSpanMonths('26.04-06'), 3);
  assert.equal(periodSpanMonths('26.04-09'), 6);
  assert.equal(periodSpanMonths('25.12-05'), 6); // 年またぎ(12月→5月)
});

test('periodSpanMonths: 年度表記("YYYY.MM"、ダッシュ無し)はnull（＝通期）を返す', () => {
  assert.equal(periodSpanMonths('2027.03'), null);
});

// parseCheckpointTrend: 実データ形式（250Aシマダヤ相当、Q1時点＝対上期進捗率）
test('parseCheckpointTrend: Q1時点（対上期進捗率）の実績・YoY・過去の進捗率を返す（実データ形式: 250Aシマダヤ）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>対上期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>24.04-06*</td><td>10,351</td><td>1,145</td><td>1,183</td><td>841</td><td>55.3</td><td>43.2</td><td>－</td></tr>
    <tr><td>25.04-06</td><td>10,749</td><td>1,045</td><td>1,066</td><td>742</td><td>48.8</td><td>37.7</td><td>25/08/12</td></tr>
    <tr><td>26.04-06</td><td>10,857</td><td>825</td><td>840</td><td>593</td><td>41.5</td><td>－</td><td>26/08/10</td></tr>
    <tr><td>前年同期比</td><td>+1.0</td><td>-21.1</td><td>-21.2</td><td>-20.1</td><td>-15.1</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseCheckpointTrend(parseTables(html));
  assert.equal(r.period, '26.04-06');
  assert.equal(r.periodMonths, 3);
  assert.equal(r.progressLabel, '対上期進捗率');
  assert.equal(r.progressPct, null); // 直近期は「－」（実測: 250Aで確認）
  assert.deepEqual(r.priorProgressPcts, [43.2, 37.7]);
  assert.deepEqual(r.priorOrdinaryProfitActuals, [1183, 1066]);
  assert.deepEqual(r.ordinaryProfit, { actual: 840, pct: -21.2, state: 'numeric' });
});

test('parseCheckpointTrend: 「黒転」等の特殊YoY表記もordinaryProfit.stateに反映する（実データ形式: 5246）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>対通期進捗率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>23.12-05</td><td>1,208</td><td>147</td><td>98</td><td>39</td><td>1.7</td><td>－</td><td>24/07/12</td></tr>
    <tr><td>24.12-05</td><td>1,690</td><td>17</td><td>-9</td><td>-451</td><td>-18.4</td><td>－</td><td>25/07/14</td></tr>
    <tr><td>25.12-05</td><td>2,799</td><td>327</td><td>298</td><td>297</td><td>10.9</td><td>119.2</td><td>26/07/14</td></tr>
    <tr><td>前年同期比</td><td>+65.6</td><td>19倍</td><td>黒転</td><td>黒転</td><td>黒転</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseCheckpointTrend(parseTables(html));
  assert.equal(r.periodMonths, 6);
  assert.equal(r.progressLabel, '対通期進捗率');
  assert.deepEqual(r.ordinaryProfit, { actual: 298, pct: null, state: 'turned_profitable' });
  assert.deepEqual(r.opProfit, { actual: 327, pct: 1800, state: 'multiple' }); // 19倍→(19-1)*100
});

// parseNextMilestoneForecast: Q1→中間期(H1)予想（実データ形式: 8185）
test('parseNextMilestoneForecast: Q1時点なら中間期(H1)予想テーブルの経常益予想・過去実績を返す（実データ形式: 8185）', () => {
  const annualHtml = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>修正1株配</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2025.02</td><td>91,835</td><td>2,193</td><td>2,566</td><td>2,923</td><td>83.1</td><td>34</td><td>25/04/11</td></tr>
    <tr><td>2026.02</td><td>81,377</td><td>1,090</td><td>1,508</td><td>237</td><td>6.9</td><td>54</td><td>26/04/10</td></tr>
    <tr><td>予 2027.02</td><td>82,500</td><td>1,400</td><td>1,700</td><td>1,100</td><td>32.4</td><td>54</td><td>26/04/10</td></tr>
    <tr><td>前期比</td><td>+1.4</td><td>+28.4</td><td>+12.7</td><td>4.6倍</td><td>4.7倍</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const h1Html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>修正1株配</th><th>発表日</th></tr></thead><tbody>
    <tr><td>23.03-08</td><td>48,089</td><td>927</td><td>1,070</td><td>830</td><td>23.7</td><td>14</td><td>23/10/13</td></tr>
    <tr><td>24.03-08</td><td>48,854</td><td>1,614</td><td>1,829</td><td>1,588</td><td>45.2</td><td>17</td><td>24/10/11</td></tr>
    <tr><td>25.03-08</td><td>41,830</td><td>1,379</td><td>1,494</td><td>921</td><td>26.5</td><td>27</td><td>25/10/10</td></tr>
    <tr><td>予 26.03-08</td><td>42,800</td><td>1,500</td><td>1,700</td><td>1,250</td><td>36.8</td><td>27</td><td>26/04/10</td></tr>
    <tr><td>前年同期比</td><td>+2.3</td><td>+8.8</td><td>+13.8</td><td>+35.7</td><td>+39.1</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const tables = parseTables(annualHtml + h1Html);
  const r = parseNextMilestoneForecast(tables, '対上期進捗率');
  assert.equal(r.forecastOrdinaryProfit, 1700);
  // 実測バグの再発防止: 末尾の「前年同期比」行（YoY%であって実額ではない
  // "+13.8"）が実績行に混入し[1070,1829,1494,13.8]になっていた。
  assert.deepEqual(r.priorOrdinaryProfitActuals, [1070, 1829, 1494]);
});

test('parseNextMilestoneForecast: 中間期(H1)決算予想を開示していない会社は「－」のみでforecastOrdinaryProfitがnullになる（推測しない。実データ形式: 250Aシマダヤ）', () => {
  const h1Html = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>修正1株配</th><th>発表日</th></tr></thead><tbody>
    <tr><td>24.04-09*</td><td>21,862</td><td>2,629</td><td>2,740</td><td>1,918</td><td>126.2</td><td>20</td><td>24/11/12</td></tr>
    <tr><td>25.04-09</td><td>22,832</td><td>2,756</td><td>2,827</td><td>1,820</td><td>119.7</td><td>26</td><td>25/11/13</td></tr>
    <tr><td>予 26.04-09</td><td>－</td><td>－</td><td>－</td><td>－</td><td>－</td><td>27</td><td>26/05/12</td></tr>
    <tr><td>前年同期比</td><td>－</td><td>－</td><td>－</td><td>－</td><td>－</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseNextMilestoneForecast(parseTables(h1Html), '対上期進捗率');
  assert.equal(r.forecastOrdinaryProfit, null);
  assert.deepEqual(r.priorOrdinaryProfitActuals, [2740, 2827]);
});

test('parseNextMilestoneForecast: 中間期(対通期進捗率)時点なら通期予想テーブルを見る（Q1時点のH1予想テーブルと取り違えない）', () => {
  const annualHtml = `<table><thead><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正1株益</th><th>修正1株配</th><th>発表日</th></tr></thead><tbody>
    <tr><td>2024.11</td><td>2,545</td><td>57</td><td>-27</td><td>-132</td><td>-5.7</td><td>0</td><td>25/01/14</td></tr>
    <tr><td>2025.11</td><td>3,895</td><td>-215</td><td>-301</td><td>-700</td><td>-28.1</td><td>0</td><td>26/01/13</td></tr>
    <tr><td>予 2026.11</td><td>5,650</td><td>350</td><td>250</td><td>250</td><td>9.2</td><td>0</td><td>26/07/14</td></tr>
    <tr><td>前期比</td><td>+45.1</td><td>黒転</td><td>黒転</td><td>黒転</td><td>黒転</td><td></td><td>(%)</td></tr>
  </tbody></table>`;
  const r = parseNextMilestoneForecast(parseTables(annualHtml), '対通期進捗率');
  assert.equal(r.forecastOrdinaryProfit, 250);
  assert.deepEqual(r.priorOrdinaryProfitActuals, [-27, -301]);
});

test('parseLatestDebtEquityRatio: 「有利子負債倍率」列の最新実績値を返す（実データ形式: 250A）', () => {
  const html = `<table><thead><tr><th>決算期</th><th>１株純資産</th><th>自己資本比率</th><th>総資産</th><th>自己資本</th><th>剰余金</th><th>有利子負債倍率</th><th>発表日</th></tr></thead><tbody>
    <tr><td>連 2025.03</td><td>1,187.65</td><td>72.7</td><td>24,824</td><td>18,058</td><td>15,360</td><td>0.01</td><td>25/05/12</td></tr>
    <tr><td>連 2026.03</td><td>1,290.61</td><td>71.0</td><td>26,004</td><td>18,462</td><td>17,074</td><td>0.01</td><td>26/05/12</td></tr>
    <tr><td>連 26.04-06</td><td>－</td><td>66.9</td><td>27,908</td><td>18,671</td><td>17,295</td><td>0.11</td><td>26/08/10</td></tr>
  </tbody></table>`;
  assert.equal(parseLatestDebtEquityRatio(parseTables(html)), 0.11);
});
