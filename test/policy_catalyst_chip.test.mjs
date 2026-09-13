// policyCatalystChip()とsmartEntryCard()への配線のテスト。
//
// Phase2の「表示専用」原則: ここではr.policyCatalystの値をそのまま
// 表示するだけで、既存のBUY SCORE等の計算には一切関与しない。
// Definition of Done「政策材料が無い銘柄では既存の画面と一致する」
// (Test5相当)をレンダリング結果でも確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyCatalystChip, smartEntryCard, scoreTrio } from '../scraper.mjs';
import { computePolicyCatalystScore } from '../policy_catalyst_score.mjs';

function sampleR(overrides = {}) {
  return {
    code: '9999', name: 'テスト銘柄', price: 1000, changePct: 0.5, closes: [1000],
    sig1: { level: null, label: 'N/A', note: null },
    sig2: { level: null, label: 'N/A', note: null },
    sig3: { level: null, label: 'N/A', note: null },
    ...overrides,
  };
}

test('policyCatalystChip: policyCatalystが無ければ空文字（既存表示に影響しない）', () => {
  assert.equal(policyCatalystChip(sampleR()), '');
  assert.equal(policyCatalystChip(sampleR({ policyCatalyst: null })), '');
});

test('policyCatalystChip: topScoreと代表イベントのtheme/reasonをそのまま表示する（再判定しない）', () => {
  const r = sampleR({
    policyCatalyst: {
      topScore: 82,
      events: [{ theme: '原油高', reason: '販売価格・権益収入の改善につながりやすい', score: 82 }],
    },
  });
  const html = policyCatalystChip(r);
  assert.match(html, /chip violet/);
  assert.match(html, /🟣 POLICY 82/);
  assert.match(html, /原油高/);
});

test('policyCatalystChip: 複数イベントがあってもtopScore=最大値の代表イベントを表示し、件数を明示する', () => {
  const r = sampleR({
    policyCatalyst: {
      topScore: 82,
      events: [
        { theme: '造船・海事産業政策', reason: '弱い材料', score: 74 },
        { theme: '防衛政策', reason: '強い材料', score: 82 },
      ],
    },
  });
  const html = policyCatalystChip(r);
  assert.match(html, /POLICY 82/);
  assert.match(html, /他1件/);
});

test('smartEntryCard: policyCatalystChipが配線されている（🟣バッジが出る）', () => {
  const r = sampleR({
    policyCatalyst: { topScore: 88, events: [{ theme: '半導体産業政策', reason: 'テスト理由', score: 88 }] },
  });
  const html = smartEntryCard(r, 0);
  assert.match(html, /🟣 POLICY 88/, 'smartEntryCard()にPOLICY CATALYSTチップが表示されていません');
});

test('smartEntryCard: policyCatalystが無い銘柄では従来通りチップが出ない（非侵食の確認）', () => {
  const html = smartEntryCard(sampleR(), 0);
  assert.doesNotMatch(html, /POLICY CATALYST|chip violet/, 'policyCatalystが無いのにチップが出ている');
});

// ---- Phase3: scoreTrio()にPolicy Catalyst Scoreを並べる ----------

function sampleWithBuyScore(overrides = {}) {
  return sampleR({
    buyScore: { score: 72, confidence: 80, detail: {} },
    expectationScore: { score: 60 },
    earningsSurpriseScore: { score: 50 },
    confidenceTier: 'HIGH',
    ...overrides,
  });
}

test('scoreTrio: Policy Catalyst Scoreがあれば既存BUY SCOREの隣にCATALYSTバッジを表示する（既存BUY SCOREの数値は変えない）', () => {
  const r = sampleWithBuyScore({
    policyCatalystScore: computePolicyCatalystScore(
      { topScore: 86, events: [{ eventId: 'e1', theme: '半導体産業政策', tier: 'direct', horizon: '0-3m', score: 86 }] },
      { repricingLag: { checked: true, score: 40 } },
    ),
  });
  const html = scoreTrio(r);
  assert.match(html, /BUY 72/, '既存BUY SCOREの表示が変わってはいけない');
  assert.match(html, /🟣 CATALYST \d+/, 'Policy Catalyst Scoreのバッジが出ていない');
  assert.match(html, /chip violet/);
});

test('scoreTrio: policyCatalystScoreがnull(政策材料なし)ならCATALYSTバッジ自体が出ない（Phase2以前と完全一致）', () => {
  const withoutCatalyst = scoreTrio(sampleWithBuyScore());
  const withNullCatalyst = scoreTrio(sampleWithBuyScore({ policyCatalystScore: null }));
  assert.equal(withoutCatalyst, withNullCatalyst);
  assert.doesNotMatch(withoutCatalyst, /CATALYST|chip violet/);
});
