// 「テンバガー候補監視リスト」（ユーザー提案2026-09-13）。通常の
// テンバガー候補（Tier A/B、東証グロース・時価総額300億〜1000億円
// レンジのみ）とは無関係に、ユーザーが個別選定した銘柄の信用需給
// （週次信用残・信用倍率・直近13週レンジ内の位置）を追跡する機能。
// 実例: TOWA(6315、東証プライム・時価総額約1,591億円で自動判定の
// Tier A/B範囲外）は「信用買い残が直近13週の高値圏(100%)に張り付いて
// いるので、これがクリアされたら買う」という需給待ちの監視銘柄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENBAGGER_WATCHLIST, TENBAGGER_WATCHLIST_CODES } from '../watchlist.mjs';
import { tenbaggerWatchCard, creditLevelZoneLabel } from '../scraper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('配線: runSmartEntryScreenがscanTenbaggerWatchlist()を呼び、出力オブジェクトのtenbaggerWatchlistに入れている', () => {
  const src = fs.readFileSync(path.join(root, 'smart_entry.mjs'), 'utf-8');
  assert.match(src, /const tenbaggerWatchlist = await scanTenbaggerWatchlist\(\)/);
  assert.match(src, /tenbaggerWatchlist,\s*\n\s*inflectionCandidates,/);
});

test('配線: scraper.mjsがsmart.tenbaggerWatchlistを読み取り、テンバガー候補セクション内でtenbaggerWatchCard()を呼んでいる', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  assert.match(src, /const tenbaggerWatchlist = smart\.tenbaggerWatchlist/);
  assert.match(src, /tenbaggerWatchlist\.map\(\(r, i\) => tenbaggerWatchCard\(r, i\)\)/);
});

test('TENBAGGER_WATCHLIST: TOWA(6315)が登録されている', () => {
  assert.ok(TENBAGGER_WATCHLIST.some((w) => w.code === '6315'), 'TOWA(6315)がTENBAGGER_WATCHLISTに見つかりません');
  assert.deepEqual(TENBAGGER_WATCHLIST_CODES, TENBAGGER_WATCHLIST.map((w) => w.code));
});

test('creditLevelZoneLabel: 67%以上は「高値圏」、33%以下は「安値圏」、それ以外は「中間圏」', () => {
  assert.equal(creditLevelZoneLabel(100), '高値圏');
  assert.equal(creditLevelZoneLabel(67), '高値圏');
  assert.equal(creditLevelZoneLabel(50), '中間圏');
  assert.equal(creditLevelZoneLabel(33), '安値圏');
  assert.equal(creditLevelZoneLabel(0), '安値圏');
});

test('creditLevelZoneLabel: データが無ければnull（推測で圏を決めない）', () => {
  assert.equal(creditLevelZoneLabel(null), null);
  assert.equal(creditLevelZoneLabel(undefined), null);
});

// tenbaggerWatchCard: 実データ相当（TOWA、2026-09-13に実測確認済み:
// 信用買い残512.72万株・信用倍率93.56倍・直近13週内位置100%）。
const towaLike = {
  code: '6315', name: 'TOWA', price: 2116, changePct: -4.77,
  market: '東証Ｐ', marketCap: 159100,
  note: '半導体製造装置（樹脂封止装置）大手。信用買い残が直近13週の高値圏に張り付いており、この需給がクリアされたら買いを検討する監視銘柄。',
  marginBuy: 5127200, marginSell: 54800, loanRatio: 93.56,
  creditTrendPct: 44.1, creditLevelPct: 100, creditDate: '26/09/04',
};

test('tenbaggerWatchCard: 実データ相当（TOWA）で信用買い残・信用倍率・直近13週内位置を表示する', () => {
  const html = tenbaggerWatchCard(towaLike, 0);
  assert.match(html, /5,127,200/);
  assert.match(html, /93\.56倍/);
  assert.match(html, /100%/);
  assert.match(html, /需給 高値圏/);
});

test('tenbaggerWatchCard: 監視メモ(note)と4週比トレンドを表示する', () => {
  const html = tenbaggerWatchCard(towaLike, 0);
  assert.match(html, /信用買い残が直近13週の高値圏に張り付いており/);
  assert.match(html, /4週比 \+44\.1%/);
});

test('tenbaggerWatchCard: 「監視リスト（手動選定）」であることを明示するチップを出す（Tier A/B/Cの自動判定と混同させない）', () => {
  const html = tenbaggerWatchCard(towaLike, 0);
  assert.match(html, /監視リスト（手動選定）/);
});

test('tenbaggerWatchCard: データ取得に失敗した場合はエラー表示にする（クラッシュしない）', () => {
  const html = tenbaggerWatchCard({ code: '6315', name: 'TOWA', fetchFailed: true }, 0);
  assert.match(html, /データ取得に失敗しました/);
});

test('tenbaggerWatchCard: 直近13週内位置が安値圏(33%以下)なら「需給 安値圏」バッジと該当キラーセル扱いになる', () => {
  const html = tenbaggerWatchCard({ ...towaLike, creditLevelPct: 20 }, 0);
  assert.match(html, /需給 安値圏/);
  assert.match(html, /infl-killer-cell hit/);
});
