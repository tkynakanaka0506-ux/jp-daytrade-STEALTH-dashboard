// ==================================================================
// us_finnhub.mjs — Finnhub 決算カレンダー（無料プラン）
//
//  SBI証券決算カレンダー（sbi.mjs）の米国版。Finnhubの
//  /calendar/earnings は日付範囲を1回問い合わせるだけで、その期間に
//  決算予定の全米企業（epsEstimate等のアナリストコンセンサス付き）が
//  返る。個別銘柄ごとの呼び出しは不要（AMBUSHの米国株ユニバースを
//  「全米市場」規模にできる理由はこれ）。
//
//  ■ 米国に「会社の公式通期予想」という概念が無いことについて
//  日本のsbi.mjsが持つestimateProfit（会社予想）とconsensusProfit
//  （アナリスト予想）の2軸比較（indicators.mjsのconsensusTrapSignal）は、
//  米国では制度上成立しない（米国企業の多くはSEC提出書類で公式な通期
//  業績予想を開示しない）。そのためepsEstimateは「コンセンサス」のみを
//  保持し、estimateProfitに相当するフィールドは持たない
//  （usEarningsTrendSignalで実績の前年同期比トレンドに代替済み）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'us_earnings_cache.json');
const REFRESH_MS = 12 * 3600 * 1000; // 半日（決算日程は日々更新されるためSBIの30日より短い）

function loadEnvKey(name) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim();
    }
  } catch { /* .env未作成 */ }
  return null;
}

const FETCH_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 2) {
  for (let i = 0; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
}

// 決算カレンダー。dateは"today"からhorizonDays先まで。stocksはコード
// （ティッカー）をキーにしたマップで返す（sbi.mjsのstocks形状に合わせる）。
export async function loadUsEarningsCalendar({ today, horizonDays = 60, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  const fresh = cache?.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < REFRESH_MS;
  if (!force && fresh && cache.date === today && cache.stocks) {
    console.log(`💾 Finnhub決算カレンダー キャッシュ有効 (${today}) — ${Object.keys(cache.stocks).length}銘柄 / リクエスト0件`);
    return cache;
  }

  const key = loadEnvKey('FINNHUB_API_KEY');
  if (!key) {
    console.error('  ⚠️ FINNHUB_API_KEY が .env に設定されていません（米国株セクションはスキップ）');
    return { date: today, stocks: {}, degraded: true };
  }

  const from = today;
  const to = new Date(new Date(`${today}T00:00:00Z`).getTime() + horizonDays * 86400000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(key)}`;

  let json;
  try {
    json = await getJson(url);
  } catch (e) {
    console.error(`  ⚠️ Finnhub決算カレンダー取得失敗: ${e.message}`);
    return cache.stocks ? cache : { date: today, stocks: {}, degraded: true };
  }

  const stocks = {};
  for (const rec of json?.earningsCalendar ?? []) {
    if (!rec.symbol || !rec.date) continue;
    // 同一銘柄が複数回現れた場合は日付が早いほうを採る（sbi.mjsと同じ方針）。
    const prev = stocks[rec.symbol];
    if (prev && prev.earningsDate <= rec.date) continue;
    stocks[rec.symbol] = {
      code: rec.symbol,
      earningsDate: rec.date,
      earningsDateStatus: 'confirmed', // Finnhubのカレンダーは確定日のみを返す（推定日という区別が無い）
      consensusEpsEstimate: Number.isFinite(rec.epsEstimate) ? rec.epsEstimate : null,
      consensusRevenueEstimate: Number.isFinite(rec.revenueEstimate) ? rec.revenueEstimate : null,
    };
  }
  console.log(`🗓  Finnhub決算カレンダー: 対象${horizonDays}日 / ${Object.keys(stocks).length}銘柄`);

  const out = { date: today, fetchedAt: new Date().toISOString(), stocks };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}

// 銘柄プロフィール（時価総額等）。netNetSignal用のmarketCapはEDINET/
// EDGARどちらの財務データにも含まれない（貸借対照表の項目ではない）ため
// 別途取得する。marketCapitalizationは百万USD単位（実測確認済み: AAPLで
// 4,591,037 → 約4.59兆ドル、実際の時価総額と整合）。indicators.mjsの
// marketCapYen()はkabutanの「百万円」単位を前提にしているが、「100万
// 単位の通貨額を生の通貨額に変換する」という処理自体は通貨に依存しない
// ため、百万USD単位のこの値をそのまま渡してよい。
export async function fetchProfile(symbol) {
  const key = loadEnvKey('FINNHUB_API_KEY');
  if (!key) return {};
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
  const json = await getJson(url);
  return {
    name: json?.name ?? null,
    marketCap: Number.isFinite(json?.marketCapitalization) ? json.marketCapitalization : null,
    shareOutstanding: Number.isFinite(json?.shareOutstanding) ? json.shareOutstanding : null,
    industry: json?.finnhubIndustry ?? null,
  };
}
