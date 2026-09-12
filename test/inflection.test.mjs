// 「業績屈折(SECTION D)」の候補判定ロジック（ユーザー提案2026-09-12の
// 詳細スクリーニング仕様。①コア・スクリーニング条件＋キラー指標3つに
// 全面置換。旧: quarterYoy<=-10%かつ回復ギャップ>=10pt、または黒字転換
// という単純な閾値だった）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInflectionEligible, buildUniverse } from '../smart_entry.mjs';
import { inflectionCard } from '../scraper.mjs';
import { coreScreeningSignal, inflectionSpreadSignal, inflectionProgressSurpriseSignal, inflectionHurdleRatioSignal, inflectionPatternType } from '../indicators.mjs';

test('isInflectionEligible: コア・スクリーニング条件を満たさなければ、キラー指標が揃っていてもfalse', () => {
  const coreScreening = coreScreeningSignal({ per: 30, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 }); // PERが範囲外
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 3 }), false);
});

test('isInflectionEligible: コア・スクリーニング条件を満たし、キラー指標が1つでも該当すれば候補入りする', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 1 }), true);
});

test('isInflectionEligible: キラー指標が1つも該当しなければfalse', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 0 }), false);
});

// ユーザー指摘（2026-09-13）「なぜ悪かったか分からない銘柄が業績屈折
// として抽出されているのは、単にギャップが大きいだけで無理やり
// 引っ張ってきている証拠」への対応。
test('isInflectionEligible: hasConcreteCause:falseなら、コア条件・キラー指標を満たしていても除外する（原因不明の無理な抽出を防ぐ）', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 3, hasConcreteCause: false }), false);
});

test('isInflectionEligible: hasConcreteCauseを省略すればtrue扱い（デフォルト、既存呼び出し元との後方互換）', () => {
  const coreScreening = coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 });
  assert.equal(isInflectionEligible({ coreScreening, killerHits: 1 }), true);
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
  coreScreening: coreScreeningSignal({ per: 12, pbr: 1, dividendYield: 3, roeHistory: { actualRoes: [10, 10], forecastRoe: 10 }, equityRatio: 50, debtEquityRatio: 0.5, evEbitda: 8 }),
  turnsProfitable: false,
  inflectionCause: { level: 'info', checked: true, causes: [{ key: 'costPressure' }], note: '粗利率が25%→20%に悪化' },
  countermeasure: { level: null, checked: true, hits: [], note: '直近の適時開示タイトルからは確認できませんでした。決算短信・決算説明資料の本文までは確認していないため、対策が無いとは限りません' },
  fundamentalRisk: { excluded: false, reasons: [] },
  patternType: inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: -19.0, hurdleRatioValue: 0.9 }),
};

// 「屈折」の2パターン分類バッジ（ユーザー提案2026-09-13）。実データ相当:
// 未来工業(7931)は1Q経常益+32.6%増益・ハードル比率0.8倍で「上方修正
// 本命型」に該当した（除外はせずバッジで区別する設計）。
test('inflectionCard: V字回復型（経常益YoYがマイナス）ならタイプバッジを出す', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /infl-type v-turnaround/);
  assert.match(html, /V字回復型/);
});

test('inflectionCard: 実データ相当（未来工業: 経常益+32.6%増益・ハードル比率0.8倍）は「上方修正本命型」バッジを出す', () => {
  const html = inflectionCard({
    ...shimadaya,
    patternType: inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: 32.6, hurdleRatioValue: 0.8 }),
  }, 0);
  assert.match(html, /上方修正本命型/);
});

// ユーザー指摘（2026-09-13）②「なぜ悪かったか」の見出し違和感の修正。
// 実測: 未来工業は+32.6%増益なのに「📉 なぜ悪かったか」という見出しが
// 付いていた（そもそも「悪く」ない）。上方修正本命型のときだけ見出しを
// 「📌 特損・留意事項」に切り替える。
test('inflectionCard: 上方修正本命型のときは「📉 なぜ悪かったか」ではなく「📌 特損・留意事項」の見出しにする', () => {
  const html = inflectionCard({
    ...shimadaya,
    patternType: inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: 32.6, hurdleRatioValue: 0.8 }),
  }, 0);
  assert.match(html, /📌 特損・留意事項/);
  assert.doesNotMatch(html, /📉 なぜ悪かったか/);
});

test('inflectionCard: V字回復型のときは従来通り「📉 なぜ悪かったか」の見出しのまま', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /📉 なぜ悪かったか/);
});

// ユーザー指摘（2026-09-13）③「予想跳躍率」というラベルなのに直近実績
// しか出ていなかった問題の修正。実データ相当: 未来工業は
// nextMilestone.forecastOrdinaryProfit=3444・前年同期実績3252から
// 通期予想YoY+5.9%を逆算でき、「直近+32.6% → 通期予想+5.9%
// （会社計画は保守的）」という実績-予想ギャップが見えるようになる。
test('inflectionCard: 予想跳躍率は「直近実績→通期会社予想」のギャップを表示する（実データ相当: 未来工業）', () => {
  const html = inflectionCard({
    ...shimadaya,
    checkpointTrend: { period: '26.04-06', ordinaryProfit: { actual: 2006, pct: 32.6, state: 'numeric' } },
    nextMilestone: { forecastOrdinaryProfit: 3444, priorOrdinaryProfitActuals: [3323, 3544, 3252] },
  }, 0);
  assert.match(html, /直近四半期 前年比\+32\.6%/);
  assert.match(html, /通期会社予想 前年比\+5\.9%/);
  assert.match(html, /会社計画は保守的/);
});

test('inflectionCard: 通期会社予想が非開示(null)なら、実績と予想のギャップではなく実績YoYだけを示す（実データ相当: シマダヤ）', () => {
  const html = inflectionCard(shimadaya, 0); // nextMilestone.forecastOrdinaryProfit: null
  assert.match(html, /経常益 前年比-19%/);
  assert.match(html, /通期会社予想は非開示のため実績との比較はできません/);
});

test('inflectionCard: どちらの型にも当てはまらなければタイプバッジを出さない', () => {
  const html = inflectionCard({
    ...shimadaya,
    patternType: inflectionPatternType({ ordinaryProfitYoyState: 'numeric', ordinaryProfitYoyPct: 10, hurdleRatioValue: 1.5 }),
  }, 0);
  assert.doesNotMatch(html, /infl-type/);
});

test('inflectionCard: 「なぜ悪かったか」「対策」「予想跳躍率」の3行が全て出力される', () => {
  const html = inflectionCard(shimadaya, 0);
  assert.match(html, /なぜ悪かったか/);
  assert.match(html, /粗利率が25%→20%に悪化/);
  assert.match(html, /対策/);
  assert.match(html, /未検出/);
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
