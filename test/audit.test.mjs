// scraper.mjsの出力前自己監査（auditGeneratedHtml）のテスト。
// これは「新しい赤旗シグナルの配線忘れ」をscraper.mjs実行のたびに
// 自動検出する恒久的な仕組みそのものが正しく働くかを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditGeneratedHtml } from '../scraper.mjs';

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
