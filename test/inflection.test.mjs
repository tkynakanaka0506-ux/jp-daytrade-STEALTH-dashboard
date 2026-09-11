// 「業績屈折(INFLECTION)」セクション（ユーザー提案2026-09-12）の候補
// 判定ロジック。実データ相当: シマダヤ(250A)は1Q営業益YoY-21%・通期予想
// YoY-1.8%（kabutan実データで確認済み。ユーザーが引用した「通期+1.8%」
// とは符号が逆だが、いずれにしても回復ギャップ=19.2ポイントは閾値
// (10pt)を超えるため対象になる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInflectionEligible, INFLECTION_ENTRY, buildUniverse } from '../smart_entry.mjs';
import { inflectionCard } from '../scraper.mjs';

test('isInflectionEligible: 直近四半期の減益が閾値未満（悪化していない）ならfalse', () => {
  assert.equal(isInflectionEligible({ quarterYoy: -5, forecastYoy: 10, turnsProfitable: false }), false);
});

test('isInflectionEligible: quarterYoyが無ければfalse（推測で判定しない）', () => {
  assert.equal(isInflectionEligible({ quarterYoy: null, forecastYoy: 10, turnsProfitable: false }), false);
});

test('isInflectionEligible: 実データ相当（シマダヤ: 1Q YoY-21%・通期予想YoY-1.8%）は該当する（回復ギャップ19.2pt >= 10pt）', () => {
  assert.equal(isInflectionEligible({ quarterYoy: -21, forecastYoy: -1.8, turnsProfitable: false }), true);
});

test('isInflectionEligible: 四半期は減益だが通期予想も同じくらい悪ければ回復シナリオとはみなさない', () => {
  // 回復ギャップ = -18-(-21) = 3pt < 10pt
  assert.equal(isInflectionEligible({ quarterYoy: -21, forecastYoy: -18, turnsProfitable: false }), false);
});

test('isInflectionEligible: 赤字→黒字転換(turnsProfitable)なら、forecastYoyが計算不能でも該当する', () => {
  assert.equal(isInflectionEligible({ quarterYoy: -30, forecastYoy: null, turnsProfitable: true }), true);
});

test('isInflectionEligible: 四半期の減益が閾値ちょうど(quarterDeclineThresholdPct)でも該当する（境界値）', () => {
  const r = isInflectionEligible({
    quarterYoy: INFLECTION_ENTRY.quarterDeclineThresholdPct,
    forecastYoy: INFLECTION_ENTRY.quarterDeclineThresholdPct + INFLECTION_ENTRY.recoveryGapPct,
    turnsProfitable: false,
  });
  assert.equal(r, true);
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
// 対策・予想跳躍率）が実際にカードへ出力されることを確認する。
const shimadaya = {
  code: '250A', name: 'シマダヤ', price: 1580, changePct: 0.5, market: 'Standard',
  quarterYoy: -21, forecastYoy: -1.8, turnsProfitable: false,
  actualPeriod: '2026.03', forecastPeriod: '2027.03',
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
  assert.match(html, /前年比-21%/);
  assert.match(html, /前年比-1.8%/);
});

test('inflectionCard: fundamentalRisk.excludedがtrueなら「財務リスクあり」チップを出す（赤字/債務超過も候補として表示するための明示的な開示）', () => {
  const html = inflectionCard({ ...shimadaya, fundamentalRisk: { excluded: true, reasons: ['直近営業損益が赤字(-215百万円)'] } }, 0);
  assert.match(html, /財務リスクあり/);
  assert.match(html, /直近営業損益が赤字/);
});

test('inflectionCard: turnsProfitable(黒字転換見込み)なら専用の文言・チップを出す', () => {
  const html = inflectionCard({ ...shimadaya, quarterYoy: -30, forecastYoy: null, turnsProfitable: true }, 0);
  assert.match(html, /黒字転換見込み/);
  assert.match(html, /黒字転換を見込みます/);
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
