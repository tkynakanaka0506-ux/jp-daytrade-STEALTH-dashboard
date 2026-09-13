// policy_catalyst_compare.mjs のテスト(③ 同一テーマ内の競合比較)。
//
// 守るべきこと:
//  1. entryPriorityScore/policyCatalystScore自体を再計算・変更しない(参照のみ)
//  2. 比較する相手がいない(テーマ内1銘柄)は結果に含めない
//  3. 未織り込み→業績感応度→バリュエーション→需給の順でカスケード比較する
//  4. データ欠損(null)は不利とみなさず、値がある方を優先するだけ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPolicyCatalystByTheme } from '../policy_catalyst_compare.mjs';
import { policyThemeComparisonSection } from '../scraper.mjs';

function stock(code, name, theme, { untapped, growthAccel, valuation, supplyDemand, policy = 88, exposure = 100, verdict = 'STRONG' } = {}) {
  const detail = {};
  if (untapped !== undefined) detail.untapped = { value: untapped };
  if (growthAccel !== undefined) detail.growthAccel = { value: growthAccel };
  if (valuation !== undefined) detail.valuation = { value: valuation };
  if (supplyDemand !== undefined) detail.supplyDemand = { value: supplyDemand };
  return {
    code, name,
    entryPriorityScore: { score: 70, confidence: 100, detail },
    policyCatalystScore: { theme, verdict, parts: { policy, exposure } },
  };
}

test('テーマ内に1銘柄しかいなければ結果に含めない(比較する相手がいない)', () => {
  const results = [stock('1111', 'A社', '造船政策', { untapped: 80 })];
  assert.deepEqual(groupPolicyCatalystByTheme(results), []);
});

test('policyCatalystScoreが無い銘柄はテーマ集計から除外する', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 80 }),
    { code: '2222', name: 'B社' }, // policyCatalystScore無し
  ];
  assert.deepEqual(groupPolicyCatalystByTheme(results), []);
});

test('未織り込み(untapped)が高い方を上位にする', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 40 }),
    stock('2222', 'B社', '造船政策', { untapped: 90 }),
  ];
  const [{ theme, stocks }] = groupPolicyCatalystByTheme(results);
  assert.equal(theme, '造船政策');
  assert.deepEqual(stocks.map((s) => s.code), ['2222', '1111']);
  assert.equal(stocks[0].rank, 1);
  assert.equal(stocks[1].rank, 2);
});

test('untappedが同点なら次の軸(growthAccel)で決める(カスケード)', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 70, growthAccel: 30 }),
    stock('2222', 'B社', '造船政策', { untapped: 70, growthAccel: 90 }),
  ];
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  assert.deepEqual(stocks.map((s) => s.code), ['2222', '1111']);
});

test('untapped・growthAccelが同点ならvaluationで決める', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 70, growthAccel: 50, valuation: 20 }),
    stock('2222', 'B社', '造船政策', { untapped: 70, growthAccel: 50, valuation: 80 }),
  ];
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  assert.deepEqual(stocks.map((s) => s.code), ['2222', '1111']);
});

test('データ欠損(null)は不利とみなさず、値がある方を優先するだけで次の銘柄には影響しない', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { growthAccel: 30 }), // untapped無し
    stock('2222', 'B社', '造船政策', { untapped: 50, growthAccel: 30 }),
  ];
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  // untappedがある2222が優先される(1111のuntapped無し=nullは不利側に回るだけ)
  assert.deepEqual(stocks.map((s) => s.code), ['2222', '1111']);
});

test('全軸データ無しの2銘柄は同点(元の順序を維持)', () => {
  const results = [
    stock('1111', 'A社', '造船政策', {}),
    stock('2222', 'B社', '造船政策', {}),
  ];
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  assert.deepEqual(stocks.map((s) => s.code), ['1111', '2222']);
});

test('同じ銘柄が重複(amb.results/smart.results両方)しても1回だけ数える', () => {
  const a = stock('1111', 'A社', '造船政策', { untapped: 80 });
  const b = stock('2222', 'B社', '造船政策', { untapped: 60 });
  const results = [a, b, { ...a }]; // 1111が重複
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  assert.equal(stocks.length, 2);
});

test('verdict・policyImpactScore・tierLabelがそのまま透過される(再判定しない)', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 25 }),
    stock('2222', 'B社', '造船政策', { untapped: 80 }),
  ];
  results[0].policyCatalystScore.verdict = 'PRICED_IN_RISK';
  results[0].policyCatalystScore.parts.exposure = 60; // indirect
  const [{ stocks }] = groupPolicyCatalystByTheme(results);
  const a = stocks.find((s) => s.code === '1111');
  assert.equal(a.verdict, 'PRICED_IN_RISK');
  assert.equal(a.tierLabel, '間接');
  assert.equal(a.policyImpactScore, 88);
});

test('複数テーマがある場合、代表銘柄のpolicyImpactScoreが高いテーマから先に並べる', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 80, policy: 60 }),
    stock('2222', 'B社', '造船政策', { untapped: 70, policy: 60 }),
    stock('3333', 'C社', '防衛政策', { untapped: 80, policy: 90 }),
    stock('4444', 'D社', '防衛政策', { untapped: 70, policy: 90 }),
  ];
  const comparisons = groupPolicyCatalystByTheme(results);
  assert.deepEqual(comparisons.map((c) => c.theme), ['防衛政策', '造船政策']);
});

test('entryPriorityScore/policyCatalystScore自体を書き換えない(副作用なし)', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 80 }),
    stock('2222', 'B社', '造船政策', { untapped: 60 }),
  ];
  const snapshot = JSON.stringify(results);
  groupPolicyCatalystByTheme(results);
  assert.equal(JSON.stringify(results), snapshot);
});

// ---- policyThemeComparisonSection() (レンダリング) ----------

test('policyThemeComparisonSection: 比較対象が無ければ空文字(セクション自体が出ない)', () => {
  assert.equal(policyThemeComparisonSection([]), '');
});

test('policyThemeComparisonSection: テーマ名・順位・銘柄・判定バッジが表示される', () => {
  const results = [
    stock('1111', 'A社', '造船政策', { untapped: 25 }),
    stock('2222', 'B社', '造船政策', { untapped: 80 }),
  ];
  results[0].policyCatalystScore.verdict = 'PRICED_IN_RISK';
  const comparisons = groupPolicyCatalystByTheme(results);
  const html = policyThemeComparisonSection(comparisons);
  assert.match(html, /POLICY CATALYST 競合比較/);
  assert.match(html, /造船政策/);
  assert.match(html, /2222/);
  assert.match(html, /1111/);
  assert.match(html, /PRICED_IN_RISK/);
  assert.match(html, /pcc-top/, '1位の行にpcc-topクラスが付いていない');
});
