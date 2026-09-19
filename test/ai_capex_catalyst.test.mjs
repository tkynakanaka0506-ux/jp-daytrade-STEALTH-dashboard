// ai_capex_catalyst.mjs のテスト(AI CAPEX CATALYST Phase1/2相当)。
//
// 守るべきこと(ユーザー指示):
//  1. intelligence_layer="corporate_capex"以外(government_policy/
//     platform_regulation)は集約対象に含めない
//  2. ai_demand_risk由来のイベントはtopScoreに加算せず、riskFlagsという
//     別枠にのみ入れる(買い材料として扱わない・売りシグナルにもしない)
//  3. 同一銘柄に複数イベントがあってもtopScore=最大値(平均・合計にしない)
//  4. 読み込み失敗はavailable:falseを返すだけでクラッシュしない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAiCapexCatalystByCode, loadAiCapexCatalystByCode } from '../ai_capex_catalyst.mjs';

function event({
  eventId = 'e1', theme = '巨大テックのAI設備投資サイクル', themeId = 'ai_capex_cycle',
  code = '8035', name = '東京エレクトロン', direction = 'watch', tier = 'direct',
  score = 70, layer = 'corporate_capex', reason = 'テスト理由',
  publishedAt = '2026-09-01 10:00', policyEventState = null,
} = {}) {
  return {
    event_id: eventId,
    theme, matched_keyword: null, reason, source: 'テスト通信', url: '',
    published_at: publishedAt,
    policy_event_state: policyEventState,
    stocks: [{
      code, name, impact: direction, tier, theme, theme_id: themeId,
      ai_capex_impact_score: score, intelligence_layer: layer,
    }],
  };
}

test('intelligence_layer=corporate_capex以外は集約対象外(government_policy)', () => {
  const byCode = buildAiCapexCatalystByCode([event({ layer: 'government_policy' })]);
  assert.deepEqual(byCode, {});
});

test('intelligence_layer=corporate_capex以外は集約対象外(platform_regulation)', () => {
  const byCode = buildAiCapexCatalystByCode([event({ layer: 'platform_regulation' })]);
  assert.deepEqual(byCode, {});
});

test('corporate_capex(ai_capex_cycle)はtopScoreに反映される', () => {
  const byCode = buildAiCapexCatalystByCode([event({ score: 88 })]);
  assert.equal(byCode['8035'].topScore, 88);
  assert.equal(byCode['8035'].events.length, 1);
  assert.equal(byCode['8035'].riskFlags.length, 0);
});

test('ai_demand_riskはtopScoreに加算されず、riskFlagsにのみ入る', () => {
  const byCode = buildAiCapexCatalystByCode([
    event({ eventId: 'e1', themeId: 'ai_capex_cycle', score: 70 }),
    event({ eventId: 'e2', themeId: 'ai_demand_risk', score: 90, theme: 'AI投資の資金負担リスク' }),
  ]);
  assert.equal(byCode['8035'].topScore, 70, 'ai_demand_riskのscoreがtopScoreを押し上げてはいけない');
  assert.equal(byCode['8035'].events.length, 1, 'ai_demand_riskはevents(買い材料)に含めない');
  assert.equal(byCode['8035'].riskFlags.length, 1);
  assert.equal(byCode['8035'].riskFlags[0].theme, 'AI投資の資金負担リスク');
});

test('ai_demand_riskしか無い銘柄はtopScore=0・events=[]のまま(riskFlagsだけ立つ)', () => {
  const byCode = buildAiCapexCatalystByCode([
    event({ themeId: 'ai_demand_risk', score: 90, theme: 'AI投資の資金負担リスク' }),
  ]);
  assert.equal(byCode['8035'].topScore, 0);
  assert.equal(byCode['8035'].events.length, 0);
  assert.equal(byCode['8035'].riskFlags.length, 1);
});

test('同一銘柄に複数のcorporate_capexイベントがあればtopScore=最大値(平均・合計にしない)', () => {
  const byCode = buildAiCapexCatalystByCode([
    event({ eventId: 'e1', score: 40 }),
    event({ eventId: 'e2', score: 75 }),
  ]);
  assert.equal(byCode['8035'].topScore, 75);
  assert.equal(byCode['8035'].events.length, 2, '元イベントは両方保持する');
});

test('同一policy_event_id(続報系列)は最新の1件に集約される(events・riskFlags双方)', () => {
  const byCode = buildAiCapexCatalystByCode([
    event({ eventId: 'e1', publishedAt: '2026-09-01 09:00', score: 40 }),
    event({ eventId: 'e1', publishedAt: '2026-09-05 09:00', score: 90 }),
  ]);
  assert.equal(byCode['8035'].events.length, 1, '同じeventIdの続報は1件に集約されるべき');
  assert.equal(byCode['8035'].topScore, 90, '最新のscoreが反映される');

  const byCodeRisk = buildAiCapexCatalystByCode([
    event({ eventId: 'e1', themeId: 'ai_demand_risk', publishedAt: '2026-09-01 09:00', reason: '初報' }),
    event({ eventId: 'e1', themeId: 'ai_demand_risk', publishedAt: '2026-09-05 09:00', reason: '深刻化' }),
  ]);
  assert.equal(byCodeRisk['8035'].riskFlags.length, 1, 'riskFlagsも同じeventIdは1件に集約されるべき');
  assert.equal(byCodeRisk['8035'].riskFlags[0].reason, '深刻化');
});

test('policy_event_state=CLOSEDの政策は集約から除外される(events・riskFlags双方)', () => {
  const byCode = buildAiCapexCatalystByCode([
    event({ policyEventState: 'CLOSED' }),
  ]);
  assert.deepEqual(byCode, {});

  const byCodeRisk = buildAiCapexCatalystByCode([
    event({ themeId: 'ai_demand_risk', policyEventState: 'CLOSED' }),
  ]);
  assert.deepEqual(byCodeRisk, {});
});

test('loadAiCapexCatalystByCode: ファイルが存在しなければavailable:falseを返すだけでクラッシュしない', () => {
  const r = loadAiCapexCatalystByCode('/nonexistent/path.json');
  assert.equal(r.available, false);
  assert.deepEqual(r.byCode, {});
});
