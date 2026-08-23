// scraper.mjsの出力前自己監査（auditGeneratedHtml）のテスト。
// これは「新しい赤旗シグナルの配線忘れ」をscraper.mjs実行のたびに
// 自動検出する恒久的な仕組みそのものが正しく働くかを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditGeneratedHtml, auditSignalShapes } from '../scraper.mjs';

const cardWith = (bodyExtra) => `<article class="card">
  <span class="code">1234</span><h2 class="name">テスト銘柄</h2>
  ${bodyExtra}
</article>`;

test('買い推奨のみ・赤チップ無し: 矛盾なし', () => {
  const html = cardWith('<span class="verdict-label">買い推奨</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('赤チップのみ・見送り: 矛盾なし', () => {
  const html = cardWith('<span class="verdict-label">見送り</span><span class="chip red">信用過多</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('買い推奨と赤チップが同居: 矛盾として検出する', () => {
  const html = cardWith('<span class="verdict-label">買い推奨</span><span class="chip red">信用過多</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /1234/);
});

test('自分ルールの✓/✗表示なのにtitleが未確認を示唆している: 矛盾として検出する', () => {
  // 実測バグ: 需給・下値で「データが不足しています」なのに✓が表示され、
  // 「未確認」と「確認済みで問題なし」が混同されていた。
  const html = cardWith('<span class="rule mint" title="信用倍率データが不足しています">✓ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /未確認/);
});

test('？(gray)表示でtitleが未確認を示唆していても矛盾ではない（正しい状態）', () => {
  const html = cardWith('<span class="rule gray" title="信用倍率データが不足しています">？ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('✓表示でtitleが確定的な内容（未確認を示唆しない）: 矛盾ではない', () => {
  const html = cardWith('<span class="rule mint" title="信用過多の兆候なし">✓ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: checked flagが無い古い形のキャッシュを検出する', () => {
  // 実測バグ: netNet/lowPbrにchecked flagを追加した後、AMBUSHキャッシュ
  // だけ再計算してSMART ENTRYキャッシュを更新し忘れた（矛盾は起きないが
  // 「？」を出し続ける形で見えにくいバグだった）。checked flagが無い
  // 古い形のシグナルオブジェクトが残っていないかを検証する。
  const staleResults = [{ code: '1234', name: 'テスト銘柄', netNet: { level: null, label: null, note: null } }];
  const issues = auditSignalShapes(staleResults, 'TEST');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /netNet/);
});

test('auditSignalShapes: checked flagがある新しい形なら検出しない', () => {
  const freshResults = [{ code: '1234', name: 'テスト銘柄', netNet: { level: null, label: null, note: null, checked: true } }];
  const issues = auditSignalShapes(freshResults, 'TEST');
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: フィールド自体が無い（未対応銘柄）場合は問題にしない', () => {
  const issues = auditSignalShapes([{ code: '1234', name: 'テスト銘柄' }], 'TEST');
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: pbrHistoricalLow（netNet/lowPbrと同じchecked flagパターンで追加した信号）もCHECKED_AWARE_FIELDS対象', () => {
  // 実測バグの再発防止: pbrHistoricalLowSignalにchecked flagを追加した際、
  // CHECKED_AWARE_FIELDSへの追加を最初は忘れていた（この監査自体が
  // 「checked flag無しの古いキャッシュ」を検出できなくなっていた）。
  const stale = [{ code: '1234', name: 'テスト銘柄', pbrHistoricalLow: { level: null, label: null, note: null } }];
  const issues = auditSignalShapes(stale, 'TEST');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /pbrHistoricalLow/);
});
