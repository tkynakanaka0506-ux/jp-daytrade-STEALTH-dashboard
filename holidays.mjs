// ==================================================================
// holidays.mjs — 日本の祝日／東証の休業日判定
//
//  ■ 出典
//  内閣府「国民の祝日について」の公開CSV（無料・APIキー不要・Shift_JIS）
//    https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
//  1955年〜翌年分まで収録されている一次情報。春分の日・秋分の日は
//  天文計算で年ごとに動き、振替休日も年によって変わるので、
//  手書きのテーブルを持たずにこれを取得する（仕様書§25の推測禁止）。
//
//  ■ 東証の休業日 = 国民の祝日 + 土日 + 年末年始(12/31〜1/3)
//  大納会は12/30、大発会は1/4（いずれも直近の営業日にずれる）。
//  1/1は祝日CSVにも入っているが、12/31・1/2・1/3は入らないため足す。
//
//  ■ 取得できなかった場合
//  祝日判定を「不明」として false（＝営業日扱い）を返す。
//  営業日扱いにすると余分なリクエストが出るだけで済むが、逆に
//  休業日扱いにすると本当の営業日のデータを取り逃すため。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'holiday_cache.json');

const CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

// CSVは年に1〜2回しか更新されない（翌年分が2月頃に追加される）。
// 30日ごとに取り直せば十分。
const REFRESH_MS = 30 * 24 * 3600 * 1000;

// ------------------------------------------------------------------
// "2026/8/11,山の日" → "2026-08-11"
// ------------------------------------------------------------------
export function parseHolidayCsv(text) {
  const dates = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*,/);
    if (!m) continue; // ヘッダ行・空行
    dates.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  }
  return dates;
}

// ------------------------------------------------------------------
// 年末年始（東証の休業日だが国民の祝日ではない日）
// ------------------------------------------------------------------
export function yearEndClosures(year) {
  return [`${year}-12-31`, `${year + 1}-01-02`, `${year + 1}-01-03`];
}

// ------------------------------------------------------------------
// 取得（30日キャッシュ）
// ------------------------------------------------------------------
export async function loadHolidays({ force = false } = {}) {
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }

  const fresh = cache?.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < REFRESH_MS;
  if (!force && fresh && Array.isArray(cache.dates)) {
    return { dates: new Set(cache.dates), coverageEnd: cache.coverageEnd, source: 'cache' };
  }

  try {
    // 他ファイルと同じ理由（Macのスリープ中にfetchが無期限に応答待ちに
    // なりプロセス全体がハングする事象の再発防止）でタイムアウトを設ける。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let res;
    try {
      res = await fetch(CSV_URL, { headers: { 'User-Agent': UA }, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 内閣府CSVはShift_JIS。res.text()だと文字化けする。
    const text = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
    const dates = parseHolidayCsv(text);
    if (dates.length < 100) throw new Error(`祝日が${dates.length}件しか取れていません（形式変更の疑い）`);

    // 年末年始を補う（収録年の範囲で）
    const years = [...new Set(dates.map((d) => Number(d.slice(0, 4))))];
    for (const y of years) dates.push(...yearEndClosures(y));

    const coverageEnd = dates.reduce((a, b) => (a > b ? a : b));
    const out = { fetchedAt: new Date().toISOString(), coverageEnd, dates: [...new Set(dates)].sort() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
    console.log(`✅ 祝日カレンダー: ${out.dates.length}日 (内閣府CSV / ${coverageEnd}まで)`);
    return { dates: new Set(out.dates), coverageEnd, source: 'network' };
  } catch (e) {
    console.error(`  ⚠️ 祝日CSVの取得失敗: ${e.message}`);
    if (cache?.dates) {
      // 期限切れでも、無いよりは古いキャッシュの方が正しい
      console.error('     → 期限切れキャッシュで継続します');
      return { dates: new Set(cache.dates), coverageEnd: cache.coverageEnd, source: 'stale-cache' };
    }
    // 祝日不明。土日判定だけで動かす（余分なリクエストは出るが取り逃さない）
    return { dates: new Set(), coverageEnd: null, source: 'unavailable' };
  }
}

// ------------------------------------------------------------------
// 判定
//   holidays … loadHolidays() が返す Set
// ------------------------------------------------------------------
export function isWeekend(iso) {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

export function isMarketHoliday(iso, holidays) {
  return isWeekend(iso) || Boolean(holidays?.has(iso));
}

export const isBusinessDay = (iso, holidays) => !isMarketHoliday(iso, holidays);
