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
} = {}) {
  return {
    event_id: eventId,
    theme, matched_keyword: null, reason, source: 'テスト通信', url: '',
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

test('loadAiCapexCatalystByCode: ファイルが存在しなければavailable:falseを返すだけでクラッシュしない', () => {
  const r = loadAiCapexCatalystByCode('/nonexistent/path.json');
  assert.equal(r.available, false);
  assert.deepEqual(r.byCode, {});
});
