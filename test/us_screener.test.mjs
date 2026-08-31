// us_screener.mjs（米国株AMBUSH）の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsRevenueTags } from '../us_screener.mjs';

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
