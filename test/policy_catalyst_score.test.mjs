// policy_catalyst_score.mjs のテスト(Phase3「検証」フェーズの土台)。
//
// Phase3で絶対に守るルール(ユーザー指示)を機械的に確認する:
//  1. Policy Catalyst Scoreを計算できる
//  2. 既存BUY SCORE(buyScore())は1点も変化しない
//  3. Policy ImpactとUNPRICEDの役割が分離されている(同じ値を使い回して
//     いない/別の意味の値を混同していない)
//  4. 同一銘柄に複数政策イベントがあっても二重加算しない(平均でも合計でもない)
//  5. policy signalなしの銘柄はnull(=既存表示に何も追加しない)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyScore } from '../indicators.mjs';
import {
  computePolicyCatalystScore, POLICY_CATALYST_WEIGHTS,
  computePriceInRiskVerdict, POLICY_STRONG_THRESHOLD, UNPRICED_LOW_THRESHOLD,
} from '../policy_catalyst_score.mjs';

function sampleEntry(overrides = {}) {
  return {
    topScore: 88,
    events: [{
      eventId: 'news-1|8035', theme: '半導体産業政策・国内投資支援', primaryTheme: '半導体産業政策・国内投資支援',
      direction: 'positive', tier: 'direct', horizon: '3-6m', score: 88,
      reason: 'テスト理由', source: 'テスト通信',
    }],
    ...overrides,
  };
}

test('Test1: policyCatalystが無ければnull(既存表示に何も追加しない)', () => {
  assert.equal(computePolicyCatalystScore(null, {}), null);
  assert.equal(computePolicyCatalystScore({ events: [] }, {}), null);
});

test('Test2: 4要素が全部揃えば加重平均どおりのスコアになり、confidenceは100', () => {
  const r = { repricingLag: { checked: true, score: 60 } };
  // policy=88(0.40) + unpriced=60(0.30) + timing(3-6m)=70(0.15) + exposure(direct)=100(0.15)
  const expected = Math.round(88 * 0.40 + 60 * 0.30 + 70 * 0.15 + 100 * 0.15);
  const result = computePolicyCatalystScore(sampleEntry(), r);
  assert.equal(result.score, expected);
  assert.equal(result.confidence, 100);
});

test('Test3: UNPRICEDは既存r.repricingLag.scoreをそのまま使う(別の値を新たに計算しない)', () => {
  const r = { repricingLag: { checked: true, score: 42 } };
  const result = computePolicyCatalystScore(sampleEntry(), r);
  assert.equal(result.parts.unpriced, 42, 'r.repricingLag.scoreをそのまま使うべき(加工や再計算をしてはいけない)');
});

test('Test3b: POLICYとUNPRICEDは別の値として独立に保持される(混同しない)', () => {
  const r = { repricingLag: { checked: true, score: 10 } };
  const result = computePolicyCatalystScore(sampleEntry({ topScore: 95 }), r);
  assert.equal(result.parts.policy, 95);
  assert.equal(result.parts.unpriced, 10);
  assert.notEqual(result.parts.policy, result.parts.unpriced);
});

test('Test4: r.repricingLagが無い/未チェックならunpricedはnull扱いになり、残り3要素で再配点する(confidenceは下がるがスコアは0点にならない)', () => {
  const result = computePolicyCatalystScore(sampleEntry(), { repricingLag: { checked: false } });
  assert.equal(result.parts.unpriced, null);
  const expected = Math.round((88 * 0.40 + 70 * 0.15 + 100 * 0.15) / (0.40 + 0.15 + 0.15));
  assert.equal(result.score, expected);
  assert.equal(result.confidence, Math.round((0.40 + 0.15 + 0.15) * 100));
});

test('Test5: time_horizon/tierが未知の値でもクラッシュせず、その要素だけ分母から除外する', () => {
  const entry = sampleEntry({ events: [{ ...sampleEntry().events[0], horizon: undefined, tier: 'unknown_tier' }] });
  const result = computePolicyCatalystScore(entry, { repricingLag: { checked: true, score: 50 } });
  assert.equal(result.parts.timing, null);
  assert.equal(result.parts.exposure, null);
  assert.ok(Number.isFinite(result.score));
});

test('Test6: 同一銘柄に複数の政策イベントがあっても、topScoreに紐づく代表イベント1件だけを使う(平均・合計にならない)', () => {
  const entry = {
    topScore: 90,
    events: [
      { eventId: 'e1', theme: '造船・海事産業政策', tier: 'indirect', horizon: '6-12m', score: 74 },
      { eventId: 'e2', theme: '防衛政策', tier: 'direct', horizon: '0-3m', score: 90 },
    ],
  };
  const r = { repricingLag: { checked: true, score: 50 } };
  const result = computePolicyCatalystScore(entry, r);
  assert.equal(result.eventId, 'e2', '最大スコアのイベント(e2)を代表として使うべき');
  assert.equal(result.parts.policy, 90, '90+74の合計でも(90+74)/2の平均でもなく、最大値90単体であるべき');
  assert.equal(result.parts.exposure, 100, '代表イベント(e2、direct)のtierを使うべき');
});

test('Test7: 既存のbuyScore()の計算結果には一切影響しない(非侵食)', () => {
  const parts = { expectedReturn: 12, unpriced: 8, surprise: 5, timing: 3, quality: 2 };
  const before = buyScore(parts);
  computePolicyCatalystScore(sampleEntry(), { repricingLag: { checked: true, score: 60 } });
  const after = buyScore(parts);
  assert.deepEqual(after, before);
});

test('Test8: theme/direction/tierはPython側の値をそのまま透過する(再判定しない)', () => {
  const entry = sampleEntry({
    events: [{ eventId: 'e1', theme: '半導体産業政策・国内投資支援', direction: 'negative', tier: 'direct', horizon: '0-3m', score: 88 }],
  });
  const result = computePolicyCatalystScore(entry, { repricingLag: { checked: true, score: 50 } });
  assert.equal(result.theme, '半導体産業政策・国内投資支援');
  assert.equal(result.direction, 'negative', 'directionを戻り値にもそのまま含めるべき(バックテストログでの再現性のため)');
  assert.equal(entry.events[0].direction, 'negative', 'computePolicyCatalystScoreが元のイベントのdirectionを書き換えてはいけない');
});

test('Test9: 入力オブジェクト(entry, r)を書き換えない(副作用なし)', () => {
  const entry = sampleEntry();
  const r = { repricingLag: { checked: true, score: 60 }, buyScore: { score: 72 } };
  const entrySnapshot = JSON.stringify(entry);
  const rSnapshot = JSON.stringify(r);
  computePolicyCatalystScore(entry, r);
  assert.equal(JSON.stringify(entry), entrySnapshot);
  assert.equal(JSON.stringify(r), rSnapshot);
});

test('重み(POLICY_CATALYST_WEIGHTS)は40/30/15/15で合計1.0', () => {
  const total = Object.values(POLICY_CATALYST_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
  assert.equal(POLICY_CATALYST_WEIGHTS.policy, 0.40);
  assert.equal(POLICY_CATALYST_WEIGHTS.unpriced, 0.30);
  assert.equal(POLICY_CATALYST_WEIGHTS.timing, 0.15);
  assert.equal(POLICY_CATALYST_WEIGHTS.exposure, 0.15);
});

// ---- ①「既に織り込み済み」検知: computePriceInRiskVerdict() ----------
//
// scoreは4要素の加重平均に潰すため、「政策は強いがUNPRICEDは低い」という
// 矛盾した組み合わせが平均されて隠れてしまう。verdictはscoreとは独立に、
// policyとunpricedの生の値だけを見て判定する(除外条件。新しい合成スコア
// を増やすものではない)。

test('computePriceInRiskVerdict: 政策強(>=閾値)×UNPRICED高 は STRONG', () => {
  assert.equal(computePriceInRiskVerdict(88, 82), 'STRONG');
});

test('computePriceInRiskVerdict: 政策強×UNPRICED低 は PRICED_IN_RISK(既に織り込み済みの可能性)', () => {
  assert.equal(computePriceInRiskVerdict(88, 25), 'PRICED_IN_RISK');
});

test('computePriceInRiskVerdict: 政策強×UNPRICED判定不能(null) は STRONG_UNKNOWN_PRICING(勝手にSTRONGとして扱わない)', () => {
  assert.equal(computePriceInRiskVerdict(88, null), 'STRONG_UNKNOWN_PRICING');
});

test('computePriceInRiskVerdict: 政策自体が弱い(<閾値)ならUNPRICEDに関わらずWEAK', () => {
  assert.equal(computePriceInRiskVerdict(50, 90), 'WEAK');
  assert.equal(computePriceInRiskVerdict(50, 10), 'WEAK');
  assert.equal(computePriceInRiskVerdict(null, 90), 'WEAK', 'policy自体がnull(判定不能)なら強いと言い切れないのでWEAK扱い');
});

test('computePriceInRiskVerdict: 閾値ちょうどの境界値', () => {
  assert.equal(computePriceInRiskVerdict(POLICY_STRONG_THRESHOLD, 100), 'STRONG', '政策=閾値ちょうどは「強い」に含める');
  assert.equal(computePriceInRiskVerdict(POLICY_STRONG_THRESHOLD - 1, 100), 'WEAK', '閾値未満は弱い扱い');
  assert.equal(computePriceInRiskVerdict(100, UNPRICED_LOW_THRESHOLD), 'PRICED_IN_RISK', 'UNPRICED=閾値ちょうどは「低い」に含める');
  assert.equal(computePriceInRiskVerdict(100, UNPRICED_LOW_THRESHOLD + 1), 'STRONG', '閾値超はSTRONG');
});

test('computePolicyCatalystScore: 戻り値にverdictが含まれ、parts(policy/unpriced)と整合する', () => {
  const pcs = computePolicyCatalystScore(sampleEntry(), { repricingLag: { checked: true, score: 25 } });
  assert.equal(pcs.verdict, 'PRICED_IN_RISK');
  assert.equal(pcs.parts.policy, 88);
  assert.equal(pcs.parts.unpriced, 25);
});
