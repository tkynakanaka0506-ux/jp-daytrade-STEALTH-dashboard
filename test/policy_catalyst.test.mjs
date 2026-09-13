// policy_catalyst.mjs のテスト(Phase2で必須とされた6項目)。
//
// このモジュールは Python側(jp-daytrade-dashboard)から受け取った
// 政策シグナルを読み込んで銘柄別に集約するだけで、BUY SCORE等の既存
// 指標には一切触れない。Test 2はその「非侵食」を機械的に確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buyScore } from '../indicators.mjs';
import { buildPolicyCatalystByCode, loadPolicyCatalystByCode } from '../policy_catalyst.mjs';

function sampleEvent(overrides = {}) {
  return {
    event_id: 'news-1|8035',
    theme: '半導体産業政策・国内投資支援',
    primary_theme: '半導体産業政策・国内投資支援',
    direction: 'positive',
    tier: 'direct',
    policy_maturity: 60,
    time_horizon: '3-6m',
    policy_impact_score: 88,
    matched_keyword: '半導体工場',
    reason: 'テスト理由',
    source: 'テスト通信',
    url: 'https://example.com/a',
    stocks: [{ code: '8035', impact: 'positive', tier: 'direct', theme: '半導体産業政策・国内投資支援', policy_impact_score: 88 }],
    ...overrides,
  };
}

// Test 1: Policy Impact 88 → 表示88
test('Test1: policy_impact_score 88 がそのまま topScore 88 として引ける', () => {
  const byCode = buildPolicyCatalystByCode([sampleEvent()]);
  assert.equal(byCode['8035'].topScore, 88);
});

// Test 2: Policy Impactを追加しても BUY/EXPECTATION/SURPRISE/UNPRICED/TIMING が完全一致
test('Test2: policy_catalyst を読み込んでも buyScore() の計算結果は変わらない(非侵食)', () => {
  const parts = {
    expectedReturn: 12, unpriced: 8, surprise: 5, timing: 3, quality: 2,
  };
  const before = buyScore(parts);
  // policy_catalyst 側の処理を挟んでも parts オブジェクトも buyScore() の
  // 実装も一切変更されていないので、結果は当然一致するはず。
  // buyScore() は {score, confidence, detail} オブジェクトを返すため
  // 値の比較には deepEqual を使う(参照比較のequalでは常に不一致になる)。
  buildPolicyCatalystByCode([sampleEvent()]);
  const after = buyScore(parts);
  assert.deepEqual(after, before, 'policy_catalystの読み込みがbuyScore()の計算に影響してはいけない');
});

// Test 3: positive / negative / watch → directionをそのまま表示(再判定しない)
test('Test3: direction はPython側の値をそのまま透過する(negativeもそのまま)', () => {
  const byCode = buildPolicyCatalystByCode([
    sampleEvent({
      direction: 'negative',
      stocks: [{ code: '6503', impact: 'negative', tier: 'direct' }],
    }),
  ]);
  assert.equal(byCode['6503'].events[0].direction, 'negative');
});

// Test 4: 同一銘柄に複数イベント → 最大Scoreを代表値にする。元イベントは失わない
test('Test4: 同一銘柄の複数イベントはtopScore=maxになり、元イベントは両方保持される', () => {
  const events = [
    sampleEvent({
      event_id: 'news-1|7011', policy_impact_score: 82,
      stocks: [{ code: '7011', impact: 'positive', tier: 'direct', policy_impact_score: 82 }],
    }),
    sampleEvent({
      event_id: 'news-2|7011', policy_impact_score: 74, theme: '造船・海事産業政策',
      stocks: [{ code: '7011', impact: 'positive', tier: 'direct', policy_impact_score: 74, theme: '造船・海事産業政策' }],
    }),
  ];
  const byCode = buildPolicyCatalystByCode(events);
  assert.equal(byCode['7011'].topScore, 82, '平均(78)でも合計(156)でもなく最大値であるべき');
  assert.equal(byCode['7011'].events.length, 2, '元イベントを1件も失ってはいけない');
});

// Test 5: 政策シグナルなし → 既存の処理・結果に影響しない
test('Test5: ファイルが存在しない場合はavailable:falseを返すだけで、例外を投げない', () => {
  const result = loadPolicyCatalystByCode('/nonexistent/path/policy_catalyst_signals.json');
  assert.equal(result.available, false);
  assert.deepEqual(result.byCode, {});
});

// Test 6: JSONが壊れている/フィールド欠損 → 既存処理を止めずunavailable扱い
test('Test6: JSONが壊れていてもクラッシュせずavailable:falseになる', () => {
  const tmpFile = path.join(os.tmpdir(), `policy_catalyst_broken_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, '{ this is not valid json');
  try {
    const result = loadPolicyCatalystByCode(tmpFile);
    assert.equal(result.available, false);
    assert.ok(result.reason, '失敗理由が入っているべき');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('Test6b: events配列が無いスキーマ不一致もavailable:falseになる', () => {
  const tmpFile = path.join(os.tmpdir(), `policy_catalyst_wrong_schema_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ signals: [] })); // events キーが無い
  try {
    const result = loadPolicyCatalystByCode(tmpFile);
    assert.equal(result.available, false);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
