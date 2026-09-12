// 「業績屈折(SECTION D)」の候補判定ロジック（ユーザー提案2026-09-12の
// 詳細スクリーニング仕様。①コア・スクリーニング条件＋キラー指標3つに
// 全面置換。旧: quarterYoy<=-10%かつ回復ギャップ>=10pt、または黒字転換
// という単純な閾値だった）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInflectionEligible, buildUniverse } from '../smart_entry.mjs';
import { inflectionCard } from '../scraper.mjs';
import { coreScreeningSignal, inflectionSpreadSignal, inflectionProgressSurpriseSignal, inflectionHurdleRatioSignal } from '../indicators.mjs';

test('isInflectionEligible: コア・スクリーニング条件を満たさなければ、キラー指標が揃っていてもfalse', () => {
  const coreScreening = coreScreeningSignal({ per: 30, pbr: 1, dividendYield: 3, roe: 10, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 }); // PERが範囲外
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 3 }), false);
});

test('isInflectionEligible: コア・スクリーニング条件を満たし、キラー指標が1つでも該当すれば候補入りする', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roe: 10, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 1 }), true);
});

test('isInflectionEligible: キラー指標が1つも該当しなければfalse', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roe: 10, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 0 }), false);
});

// buildUniverseの手動ウォッチリスト経由でシマダヤがユニバースに入る
// ことは test/watchlist.test.mjs で確認済み。ここではINFLECTION候補
// 判定自体がbuildUniverseとは独立した純粋関数であることだけ確認する
// （ユニバースに入った銘柄がすべて自動的にINFLECTION候補になるわけ
// ではなく、実際の財務データがisInflectionEligibleの条件を満たす
// 必要がある）。
test('buildUniverse自体はINFLECTION判定に一切関与しない（ユニバース入り≠INFLECTION候補）', () => {
  const universe = buildUniverse({ tdNames: {}, sbiStocks: {} });
  assert.equal(universe['250A'], 'シマダヤ');
  assert.equal(typeof isInflectionEligible, 'function');
});

// inflectionCard（scraper.mjs）: ユーザー要望の3行（なぜ悪かったか・
// 対策・予想跳躍率）＋新スペックのキラー指標・コアスクリーニングが
// 実際にカードへ出力されることを確認する。
const shimadaya = {
  code: '250A', name: 'シマダヤ', price: 1580, changePct: 0.5, market: 'Standard',
  per: 12, pbr: 1.0, dividendYield: 3.0,
  checkpointTrend: { period: '26.04-06', ordinaryProfit: { actual: 840, pct: -19.0, state: 'numeric' } },
  nextMilestone: { forecastOrdinaryProfit: null },
  spread: inflectionSpreadSignal({ revenueYoyPct: 1.0, revenueYoyState: 'numeric', ordinaryProfitYoyPct: -19.0, ordinaryProfitYoyState: 'numeric' }),
  progressSurprise: inflectionProgressSurpriseSignal({ progressPct: 50, priorProgressPcts: [40, 42] }),
  hurdleRatio: inflectionHurdleRatioSignal({ checkpointOrdinaryProfitActual: 900, nextMilestoneForecastOrdinaryProfit: 1000, priorCheckpointOrdinaryProfitActuals: [800, 800], priorMilestoneOrdinaryProfitActuals: [1000, 1000] }),
  killerHits: 3,
  coreScreening: coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roe: 10, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 }),
  turnsProfitable: false,
  inflectionCause: { level: 'info', checked: true, causes: [{ key: 'costPressure' }], note: '粗利率が25%→20%に悪化' },
  countermeasure: { level: null, checked: true, hits: [], note: '直近の適時開示タイトルからは確認できませんでした。決算短信・決算説明資料の本文までは確認していないため、対策が無いとは限りません' },
  fundamentalRisk: { excluded: false, reasons: [] },
};

test('inflectionCard: 「なぜ悪かったか」「対策」「予想跳躍率」の3行が全て出力される', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /なぜ悪かったか/);
  assert.match(html, /粗利率が25%→20%に悪化/);
  assert.match(html, /対策/);
  assert.match(html, /本文までは確認していません/);
  assert.match(html, /予想跳躍率/);
});

test('inflectionCard: キラー指標3つ（スプレッド・進捗サプライズ・ハードル比率）の値を表示する', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /スプレッド/);
  assert.match(html, /進捗サプライズ/);
  assert.match(html, /ハードル比率/);
});

test('inflectionCard: killerHits===3（全キラー指標該当）なら「最優先候補」バッジを出す', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /最優先候補/);
});

test('inflectionCard: killerHitsが3未満なら「最優先候補」バッジを出さない', () => {
  const html = inflectionCard({ ...shimadaya, killerHits: 1 }, 0);
  assert.doesNotMatch(html, /最優先候補/);
});

test('inflectionCard: fundamentalRisk.excludedがtrueなら「財務リスクあり」チップを出す（赤字/債務超過も候補として表示するための明示的な開示）', () => {
  const html = inflectionCard({ ...shimadaya, fundamentalRisk: { excluded: true, reasons: ['直近営業損益が赤字(-215百万円)'] } }, 0);
  assert.match(html, /財務リスクあり/);
  assert.match(html, /直近営業損益が赤字/);
});

test('inflectionCard: turnsProfitable(黒字転換見込み)なら専用の文言・チップを出す', () => {
  const html = inflectionCard({
    ...shimadaya, turnsProfitable: true,
    checkpointTrend: { period: '25.11', ordinaryProfit: { actual: 298, pct: null, state: 'turned_profitable' } },
  }, 0);
  assert.match(html, /黒字転換見込み/);
  assert.match(html, /黒字転換/);
});

test('inflectionCard: causesが無ければ「要因不明」相当の文言、countermeasureがgoodなら対策の内容を出す', () => {
  const html = inflectionCard({
    ...shimadaya,
    inflectionCause: { level: null, checked: true, causes: [], note: '要因不明' },
    countermeasure: { level: 'good', checked: true, hits: [{ date: '2026-09-01', title: '製品の価格改定に関するお知らせ' }], note: '2026-09-01 「製品の価格改定に関するお知らせ」' },
  }, 0);
  assert.match(html, /いずれにも該当しませんでした/);
  assert.match(html, /価格改定に関するお知らせ/);
});
