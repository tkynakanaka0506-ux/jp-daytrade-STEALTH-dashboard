// scraper.mjsの「自分ルール」チェックリスト(buyRuleChecklist)の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyRuleChecklist } from '../scraper.mjs';

const row = (rows, label) => rows.find((r) => r.label === label);

test('需給: marginOverhangがbadでもsqueezeがgoodならOK扱いにする（OR条件）', () => {
  // 実測バグ: 「信用倍率が過度に高くない、または空売りが積み上がっている」
  // というOR条件のはずが、marginOverhangだけを見ておりsqueezeを無視していた
  // （6966三井ハイテックで両方成立していたのに需給✗と誤表示）。
  const r = {
    marginOverhang: { level: 'bad', note: '信用過多' },
    squeeze: { level: 'good', note: '踏み上げ狙い' },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, true);
  assert.match(row(rows, '需給').note, /踏み上げ/);
});

test('需給: squeezeが無く marginOverhangがbadなら✗', () => {
  const r = { marginOverhang: { level: 'bad', note: '信用過多', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, false);
});

test('需給: 信用倍率データが無ければ？のまま（未確認と混同しない）', () => {
  // 実測バグ: 石井表記等4銘柄はloanRatio自体が無いのに「✓ 信用過多の
  // 兆候なし」＝確認済みと誤表示していた。
  const r = { marginOverhang: { level: null, note: null, checked: false } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, null);
  assert.match(row(rows, '需給').note, /不足/);
});

test('下値: netNet/lowPbrともデータが揃っていて該当しないなら✗（未確認と混同しない）', () => {
  // 実測バグ: PBR・業種平均PBRのデータが完全に揃っていて「割安ではない」
  // と確認できる銘柄（350A等11銘柄）でも、checked flagが無かったため
  // 一律「？（確認できず）」と表示されていた。
  const r = {
    netNet: { level: null, note: null, checked: true },
    lowPbr: { level: null, note: null, checked: true },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, false);
  assert.match(row(rows, '下値').note, /裏付けなし/);
});

test('下値: データ自体が無ければ？のまま', () => {
  const r = {
    netNet: { level: null, note: null, checked: false },
    lowPbr: { level: null, note: null, checked: false },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, null);
});

test('下値: lowPbrがgoodなら✓', () => {
  const r = { lowPbr: { level: 'good', note: '割安', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, true);
});

test('タイミング: 決算日が不明ならok:null（「確認できて問題なし」と混同しない）', () => {
  // 実測バグ: SMART ENTRY銘柄（決算日不明）でも常に✓が出ていた
  // （earningsWarningはdaysLeftが無ければ常にlevel:nullになるため）。
  const r = { earningsDaysLeft: null, earningsWarning: { level: null } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, 'タイミング').ok, null);
});

test('タイミング: 決算日がわかっていて間近でなければ✓', () => {
  const r = { earningsDaysLeft: 20, earningsWarning: { level: null } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, 'タイミング').ok, true);
});

test('期待値: 会社予想だけ無い場合とコンセンサスだけ無い場合を文言で区別する', () => {
  // 実測バグ: 原因を区別せず一律「コンセンサスN/A」と表示していた
  // （4716日本オラクルは実際にはコンセンサスがあり会社予想だけ無かった）。
  const onlyConsensus = buyRuleChecklist({ estimateProfit: null, consensusProfit: 100 });
  assert.match(row(onlyConsensus, '期待値').note, /会社予想N\/A/);

  const onlyEstimate = buyRuleChecklist({ estimateProfit: 100, consensusProfit: null });
  assert.equal(row(onlyEstimate, '期待値').note, 'コンセンサスN/A');

  const neither = buyRuleChecklist({ estimateProfit: null, consensusProfit: null });
  assert.match(row(neither, '期待値').note, /共にN\/A/);
});

test('財務: warn判定は✓にしない（異常ありなのに問題なしと表示しない）', () => {
  // 実測バグ: level==='warn'でも✓が出ていた（'bad'しか除外していなかった）。
  const r = { receivablesAnomaly: { level: 'warn', note: 'x', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '財務').ok, false);
});

test('財務: 未確認（checked:false）は✓でも✗でもなくnull', () => {
  const r = { receivablesAnomaly: { level: null, note: null, checked: false } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '財務').ok, null);
});
