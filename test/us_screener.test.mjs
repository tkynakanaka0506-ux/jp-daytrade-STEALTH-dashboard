// us_screener.mjs（米国株AMBUSH）の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsRevenueTags, usScore } from '../us_screener.mjs';

test('usScore: kairi（乖離率）を渡すとスコアが変わる（実測バグ: ALOYのSCOREが2026-08-30〜09-02の4日間、価格・RSI・出来高Z・仕込みゾーンが全て変化したにもかかわらず70のまま固定されていた。原因はunpricedScore(kairi)をimportしていながらusScoreの計算式に配線し忘れていたこと）', () => {
  const base = { netNet: { level: null }, receivablesAnomaly: { level: null }, earningsTrend: { level: null } };
  const near = usScore({ ...base, kairi: 1 }); // 乖離小さい→未織込→加点大
  const far = usScore({ ...base, kairi: 10 }); // 乖離大きい→加点小
  assert.ok(near > far, `kairiが小さいほど加点されるはず（near=${near}, far=${far}）`);
});

test('usScore: kairiが無くても（null/undefined）例外にならず、従来通り基礎点+ファンダメンタルズのみで計算される', () => {
  const base = { netNet: { level: 'good' }, receivablesAnomaly: { level: null }, earningsTrend: { level: null } };
  assert.equal(usScore({ ...base, kairi: null }), 65);
  assert.equal(usScore(base), 65);
});

// 再発防止策（ユーザー指示「なぜ順位が間違っていたのか」を受けて全ランキング
// 関数を横断監査した結果の一環）: カタリスト予兆のprecursorRankで見つかった
// 「悪材料が加点に紛れ込む」バグと同じ性質（単調性: 悪材料が付くほど
// 順位が上がってはいけない）が、usScoreにも無いことを確認するテスト。
test('usScore: earningsTrend/receivablesAnomalyがbad/warnならscoreが下がる（悪材料が加点に紛れ込む再発防止）', () => {
  const clean = { netNet: { level: null }, receivablesAnomaly: { level: null }, earningsTrend: { level: null }, kairi: null };
  const earningsBad = usScore({ ...clean, earningsTrend: { level: 'bad' } });
  const receivablesBad = usScore({ ...clean, receivablesAnomaly: { level: 'bad' } });
  const receivablesWarn = usScore({ ...clean, receivablesAnomaly: { level: 'warn' } });
  const cleanScore = usScore(clean);
  assert.ok(earningsBad < cleanScore, `earningsTrend=badでscoreが下がりません（clean=${cleanScore}, bad=${earningsBad}）`);
  assert.ok(receivablesBad < cleanScore, `receivablesAnomaly=badでscoreが下がりません（clean=${cleanScore}, bad=${receivablesBad}）`);
  assert.ok(receivablesWarn < cleanScore, `receivablesAnomaly=warnでscoreが下がりません`);
  assert.ok(receivablesWarn > receivablesBad, `receivablesAnomalyのwarnはbadより減点が軽いはずです`);
});

test('supportsRevenueTags: Bankingはfalse（実測バグ: GBCI66.4倍・WAFD86.2倍のPSR異常値の再発防止。ASC606の売上高タグは銀行の受取利息を捕捉できない）', () => {
  assert.equal(supportsRevenueTags('Banking'), false);
});

test('supportsRevenueTags: Real Estate・Insurance・Financial Servicesはtrue（実データでPSRが妥当な水準だったため対象外にしない。FR11倍・PLD15倍・TRV1.6倍で確認済み）', () => {
  assert.equal(supportsRevenueTags('Real Estate'), true);
  assert.equal(supportsRevenueTags('Insurance'), true);
  assert.equal(supportsRevenueTags('Financial Services'), true);
});

test('supportsRevenueTags: 未知の業種・nullはtrue（判定材料が無い業種を誤って除外しない）', () => {
  assert.equal(supportsRevenueTags('Technology'), true);
  assert.equal(supportsRevenueTags(null), true);
  assert.equal(supportsRevenueTags(undefined), true);
});
