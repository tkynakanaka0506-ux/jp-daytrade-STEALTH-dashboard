// ==================================================================
// sbi.mjs — SBI証券「決算発表スケジュール」クライアント
//
//  実体は IRIS (vc.iris.sbisec.co.jp) の JSONP API。
//  公開ページのみを叩く。ログイン・Cookie・取引操作は一切行わない。
//
//  調査で判明した仕様（2026-08 実測）:
//   * 文字コードは Shift_JIS。res.text() は使えない（TextDecoderが必須）
//   * JSONP。callback は省略可で、その場合 "( ... )" だけで包まれて返る
//   * hash / type=delay は必須。不正だと HTTP 200 のまま
//     本文 "<!-- ERROR Calendar -->" が返るのでステータスでは判定できない
//   * announcement_info_stock.do は 1銘柄ずつのみ（カンマ区切りは0件）
//   * 未来ホライズンは概ね2ヶ月。それ以遠は件数0
//
//  確定日 / 参考値の判別（88件で相関検証・例外0）:
//     announcementKbn = "2" … 取引所発表の確定日        → confirmed
//     announcementKbn = "1" … 前年同期を置換した参考値  → estimated
//                             （date が "2026/09 中旬" と旬表記になる）
//     announcementKbn = "3" … 発表済（過去）            → announced
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'sbi_earnings_cache.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const IRIS = 'https://vc.iris.sbisec.co.jp/calendar/settlement/stock';
const SCHEDULE_PAGE =
  'https://www.sbisec.co.jp/ETGate/?_ControlID=WPLETmgR001Control&_PageID=WPLETmgR001Mdtl20' +
  '&_DataStoreID=DSWPLETmgR001Control&_ActionID=DefaultAID&burl=iris_economicCalendar' +
  '&cat1=market&cat2=economicCalender&dir=tl1-cal%7Ctl2-schedule%7Ctl3-stock%7Ctl4-calsel' +
  '&file=index.html&getFlg=on';

// ページから抽出できなかった場合の最終フォールバック（2026-08時点の実値）
const FALLBACK_HASH = '14a0ba830d7ad7dcf3cc8e24767960221cbd6174';
const REQ_GAP = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Shift_JIS を取り出す
// ------------------------------------------------------------------
async function getSJIS(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.sbisec.co.jp/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return new TextDecoder('shift_jis').decode(await res.arrayBuffer());
}

// ------------------------------------------------------------------
// JSONP の中身を JSON.parse できる形に正規化する
//
// eval は使わない（遠隔から取得したコードを実行しないため）。
// IRISの応答は素のJSオブジェクトリテラルで、JSONとしては2点だけ不正:
//   (a) 一部のキーが引用符なし   例: `link : {`
//   (b) 配列・オブジェクトの末尾カンマ  例: `},\n\t]`
// 単純な正規表現置換だと文字列値の中身まで壊しうるので、
// 文字列の内外を追跡しながら1パスで書き換える。
// ------------------------------------------------------------------
function sanitizeToJson(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += src[++i] ?? ''; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }

    // (b) 末尾カンマ: 次の非空白が ] または } なら捨てる
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ']' || src[j] === '}') continue;
      out += ch;
      continue;
    }

    // (a) 裸キー: 識別子のあと（空白を挟んで）":" が来ていれば引用符で包む
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      const word = src.slice(i, j);
      if (src[k] === ':') {
        out += `"${word}"`;
        i = j - 1;
        continue;
      }
      out += word;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonp(text) {
  if (text.includes('ERROR Calendar')) throw new Error('IRIS: ERROR Calendar（hash失効の可能性）');
  const s = text.indexOf('(');
  const e = text.lastIndexOf(')');
  if (s === -1 || e <= s) throw new Error('IRIS: JSONP形式ではありません');
  try {
    return JSON.parse(sanitizeToJson(text.slice(s + 1, e)));
  } catch (err) {
    throw new Error(`IRIS: JSON解析失敗 — ${err.message}`);
  }
}

async function irisGet(endpoint, params, hash) {
  const q = new URLSearchParams({ hash, type: 'delay', ...params });
  return parseJsonp(await getSJIS(`${IRIS}/${endpoint}?${q}`));
}

// ------------------------------------------------------------------
// hash はページ内に埋め込まれている。ローテーションに備えて毎日拾い直す。
// ------------------------------------------------------------------
export async function fetchHash() {
  try {
    const html = await getSJIS(SCHEDULE_PAGE);
    const m = html.match(/hash=([0-9a-f]{40})/);
    if (m) return m[1];
    console.error('  ⚠️ SBIページからhashを抽出できず。既知の値で継続します。');
  } catch (e) {
    console.error(`  ⚠️ SBIページ取得失敗 (${e.message})。既知のhashで継続します。`);
  }
  return FALLBACK_HASH;
}

// ------------------------------------------------------------------
// 正規化
// ------------------------------------------------------------------
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const toNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ymd = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

const KBN = {
  2: { status: 'confirmed', source: 'sbi_exchange' },
  1: { status: 'estimated', source: 'sbi_previous_year_reference' },
  3: { status: 'announced', source: 'sbi_exchange' },
};

function normalize(rec, retrievedAt) {
  const meta = KBN[rec.announcementKbn] ?? { status: 'unknown', source: null };
  const rawDate = strip(rec.date);
  const exact = /^\d{4}\/\d{2}\/\d{2}$/.test(rawDate);
  // 確定日は date（実日付）を、参考値は orderDate（旬の代表日）を使う
  const approx = ymd(rec.orderDate);
  // 会社予想達成率は "109,233 ( 24.2％ )" の形で来る。
  // 未算出の銘柄は "( --％ )" なので、必ず数値であることを確認してから採る
  // （"--" は parseFloat で NaN になり、そのまま通すと N/A が数値化されてしまう）。
  const m = strip(rec.profitAndRate).match(/\(\s*(-?[\d.]+)\s*％/);
  const rate = m && Number.isFinite(parseFloat(m[1])) ? parseFloat(m[1]) : null;

  return {
    code: rec.productCode,
    name: strip(rec.productName),
    exchange: rec.exchangeCode,
    earningsDate: exact ? rawDate.replace(/\//g, '-') : null,
    earningsDateApprox: approx,
    earningsDateRaw: rawDate,
    earningsDateStatus: meta.status,
    earningsDateSource: meta.source,
    earningsDateRetrievedAt: retrievedAt,
    quarter: strip(rec.type),
    estimateProfit: toNum(rec.orderEstimate) ?? toNum(rec.estimate),
    consensusProfit: toNum(rec.consensus),
    achievedRate: rate,
    progressStatus: rec.progressStatus && rec.progressStatus !== 'NODATA' ? rec.progressStatus : null,
  };
}

// ------------------------------------------------------------------
// 公開API
// ------------------------------------------------------------------
export async function fetchCalendarDays(hash, baseYM, selectedDate, span = 2) {
  const cal = await irisGet('announcement_calendar_list.do', { baseYM, selectedDate, span: String(span) }, hash);
  return cal.body
    .flatMap((mo) => mo.detail.flatMap((d) => d.week))
    .filter((w) => w.date && Number(w.count) > 0)
    .map((w) => ({ date: w.date, count: Number(w.count) }));
}

export async function fetchByDate(hash, selectedDate) {
  const j = await irisGet('announcement_info_date.do', { selectedDate }, hash);
  return j.body ?? [];
}

export async function fetchByStock(hash, code) {
  const j = await irisGet('announcement_info_stock.do', { productCode: code, inputWord: '' }, hash);
  return j.body ?? [];
}

// ------------------------------------------------------------------
// 決算カレンダー全体を取得（日次キャッシュ）
//
//  today から horizonDays 先までの「発表がある日」を列挙し、
//  各日の全銘柄を取得して code をキーにしたマップを返す。
//  実測: 対象16日で IRIS 17リクエスト / 242銘柄。
// ------------------------------------------------------------------
export async function loadEarningsCalendar({ today, horizonDays = 60, extraCodes = [], force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.stocks) {
    console.log(`💾 SBI決算カレンダー キャッシュ有効 (${today}) — ${Object.keys(cache.stocks).length}銘柄 / リクエスト0件`);
    return cache;
  }

  const retrievedAt = new Date().toISOString();
  const hash = await fetchHash();
  await sleep(REQ_GAP);

  const t = new Date(`${today}T00:00:00Z`);
  const limit = new Date(t.getTime() + horizonDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const base = today.slice(0, 7).replace('-', '');
  const compact = today.replace(/-/g, '');

  let days = [];
  try {
    days = await fetchCalendarDays(hash, base, compact, 2);
  } catch (e) {
    console.error(`  ⚠️ SBIカレンダー取得失敗: ${e.message}`);
    return cache.stocks ? cache : { date: today, hash, retrievedAt, stocks: {}, degraded: true };
  }
  const target = days.filter((d) => d.date >= compact && d.date <= limit);
  console.log(`🗓  SBI決算カレンダー: 対象${target.length}日 / 総${target.reduce((a, d) => a + d.count, 0)}件`);

  const stocks = {};
  let reqs = 2;
  for (const d of target) {
    await sleep(REQ_GAP);
    try {
      for (const rec of await fetchByDate(hash, d.date)) {
        const n = normalize(rec, retrievedAt);
        // 同一銘柄が複数日に現れた場合は日付が早いほうを採る
        const prev = stocks[n.code];
        if (!prev || (n.earningsDateApprox ?? '9999') < (prev.earningsDateApprox ?? '9999')) stocks[n.code] = n;
      }
      reqs++;
    } catch (e) {
      console.error(`  ⚠️ ${d.date} 取得失敗: ${e.message}`);
    }
  }

  // カレンダーに載っていない銘柄（ホライズン外＝次回決算が2ヶ月以上先）は
  // 銘柄別APIで直近の発表実績だけ拾い、status は unknown のままにする。
  for (const code of extraCodes) {
    if (stocks[code]) continue;
    await sleep(REQ_GAP);
    try {
      const rows = await fetchByStock(hash, code);
      reqs++;
      if (!rows.length) continue;
      const n = normalize(rows[0], retrievedAt);
      if (n.earningsDateStatus === 'announced') {
        // 次回予定は不明。前回実績（達成率・進捗判定）だけ保持する。
        stocks[code] = { ...n, earningsDate: null, earningsDateStatus: 'unknown', earningsDateSource: null, lastAnnounced: n.earningsDate ?? n.earningsDateApprox };
      } else {
        stocks[code] = n;
      }
    } catch (e) {
      console.error(`  ⚠️ ${code} 銘柄別取得失敗: ${e.message}`);
    }
  }

  const out = { date: today, hash, retrievedAt, requests: reqs, stocks };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ SBI決算カレンダー: ${Object.keys(stocks).length}銘柄 / IRIS ${reqs}リクエスト`);
  return out;
}
