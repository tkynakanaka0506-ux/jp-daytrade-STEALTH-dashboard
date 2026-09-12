// ==================================================================
// jpx.mjs — JPX（日本取引所グループ）の「東証上場銘柄一覧」
//
//  ■ 出典
//  https://www.jpx.co.jp/markets/statistics-equities/misc/01.html
//  無料・APIキー不要のExcel(.xlsx)ファイル。全上場銘柄のコード・銘柄名・
//  市場区分（プライム/スタンダード/グロース/ETF等）・業種を収録。
//
//  ■ ユーザー要望（2026-09-13）「スキャンの範囲もう少し広げられません
//  か」への対応。smart_entry.mjsのbuildUniverseは元々「東証の全銘柄
//  マスタは保有していない」という制約でTDnet直近14営業日の開示銘柄∪
//  SBI決算カレンダー銘柄だけをスキャンしていた（実例: TOWA(6315)の
//  ような直近開示の無い大型株は監視リスト等で手動追加するしかなかった）。
//  このファイルで「全銘柄マスタが無い」という制約自体を解消できる。
//
//  ■ まずは小さく試す（ユーザー判断、2026-09-13）
//  全市場（約3,800銘柄）に一気に広げるとSMART ENTRY Stage 1の実行時間が
//  倍近くに伸びる見込みのため、まずプライム市場銘柄だけを追加し、実際の
//  増加時間を確認してから段階的に広げる方針。exportするfetchListedIssues
//  は市場区分を含む全件を返すので、呼び出し側で絞り込む。
//
//  ■ xlsxのパース方法（新規の依存ライブラリを追加しない）
//  xlsxは実体がzipアーカイブ（中身はXML）。edinet.mjsのunzip()
//  （EDINETのZIP形式書類取得のために自前実装済み、zlib標準ライブラリ
//  のみで動く）をそのまま流用できる。文字列は共有文字列テーブル
//  （xl/sharedStrings.xml）にインデックスで格納されているため、
//  セル側（xl/worksheets/sheet1.xml）のt="s"参照を解決する。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { unzip } from './edinet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'jpx_listed_cache.json');

const LISTING_PAGE_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30_000;

// JPXはファイル名にハッシュ値が入ったパスを使っており固定URLではない
// （実測: tvdivq0000001vg2-att/data_j.xlsx）。更新時にパスが変わりうる
// ため、都度一覧ページからxlsxへのリンクを拾う。
const REFRESH_MS = 24 * 3600 * 1000; // JPXの更新頻度（月1〜2回程度）に対して十分な余裕

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function findXlsxUrl() {
  const res = await fetchWithTimeout(LISTING_PAGE_URL);
  const html = await res.text();
  const m = html.match(/href="([^"]+data_j\.xlsx)"/i);
  if (!m) throw new Error('一覧ページからdata_j.xlsxへのリンクが見つかりません（ページ構成の変更の疑い）');
  return new URL(m[1], LISTING_PAGE_URL).href;
}

// xlsxの共有文字列テーブル（xl/sharedStrings.xml）を配列にする。
// <si><t>text</t></si> の並び順がそのままインデックスに対応する。
export function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>(?:<t[^>]*>([^<]*)<\/t>|<t[^>]*\/>)?.*?<\/si>/gs)].map((m) => m[1] ?? '');
}

// xlsxのシート（xl/worksheets/sheet1.xml）を行の配列にする。各行は
// 列文字（A,B,C...）→値のオブジェクト。t="s"の場合はsharedStringsの
// インデックスとして文字列に解決する。
export function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const obj = {};
    for (const [, col, type, val] of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+"(?:\s+t="(\w+)")?[^>]*>(?:<v>([^<]*)<\/v>)?<\/c>/g)) {
      obj[col] = type === 's' ? sharedStrings[Number(val)] : val;
    }
    rows.push(obj);
  }
  return rows;
}

// data_j.xlsxの生バイト列 → {code, name, market, sector33}の配列。
// 見出し行（1行目）はコード列が無いことで自動的に除外する。
export function parseListedIssuesXlsx(buf) {
  const entries = unzip(buf);
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const sheetEntry = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
  if (!ssEntry || !sheetEntry) throw new Error('xlsx内にsharedStrings.xml/sheet1.xmlが見つかりません（形式変更の疑い）');
  const sharedStrings = parseSharedStrings(ssEntry.data.toString('utf-8'));
  const rows = parseSheetRows(sheetEntry.data.toString('utf-8'), sharedStrings);
  return rows
    .map((r) => ({ code: r.B, name: r.C, market: r.D, sector33: r.F }))
    .filter((r) => /^[0-9A-Z]{4}$/.test(r.code ?? '')); // 見出し行・空行を除外
}

// ------------------------------------------------------------------
// 取得（24時間キャッシュ）
// ------------------------------------------------------------------
export async function loadListedIssues({ force = false } = {}) {
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }

  const fresh = cache?.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < REFRESH_MS;
  if (!force && fresh && Array.isArray(cache.issues)) {
    return { issues: cache.issues, source: 'cache' };
  }

  try {
    const xlsxUrl = await findXlsxUrl();
    const res = await fetchWithTimeout(xlsxUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const issues = parseListedIssuesXlsx(buf);
    if (issues.length < 3000) throw new Error(`上場銘柄が${issues.length}件しか取れていません（形式変更の疑い）`);
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), issues }, null, 2));
    console.log(`✅ JPX上場銘柄一覧: ${issues.length}件`);
    return { issues, source: 'live' };
  } catch (e) {
    console.error(`  ⚠️ JPX上場銘柄一覧の取得に失敗: ${e.message}`);
    if (Array.isArray(cache?.issues)) return { issues: cache.issues, source: 'stale-cache' };
    return { issues: [], source: 'unavailable' };
  }
}
