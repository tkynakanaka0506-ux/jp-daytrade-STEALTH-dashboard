// ==================================================================
// us_tenbagger.mjs — 米国株テンバガー候補（決算日非依存、ユーザー提案）
//
//  us_screener.mjs（米国株AMBUSH）とは完全に分離する。AMBUSHは「決算前
//  の待ち伏せ」ロジックなので決算T+14〜45日のユニバースで正しいが、
//  テンバガー探索は決算時期に関係なく「現在の株価・業績・テーマから
//  将来の大幅成長余地があるか」を見るべきもの。
//
//  ■ 実データで発覚した旧設計の欠陥
//  以前はテンバガー候補の米国株をus_screener.mjs（AMBUSHユニバース）
//  から流用していたため、次回決算が窓の外にある銘柄が機械的に除外
//  されていた（実測: IONQは決算カレンダー取得範囲60日以内に無く
//  ユニバース外、Aurora Innovation/AURは決算が58日後でAMBUSHの窓
//  (T+45日)を超えるため除外）。
//
//  ■ ユニバースの作り方（キュレーションリスト方式、ユーザー承認済み）
//  無料で米国株全銘柄（数千社）を毎日走査する手段が無い（Finnhubの
//  時価総額取得(/stock/profile2)は1銘柄1リクエストのため数千銘柄は
//  非現実的）。日本株のテーマ調査（tenbagger_research_log.md）と同じ
//  「手動リサーチで対象を絞り込む」手法をコードに落とし込み、
//  US_TENBAGGER_WATCHLISTに追記していく運用にする（自動発見はしない）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailyBars } from './us_yahoo.mjs';
import { loadTickerCikMap, fetchCompanyFacts, extractQuarterlyTrend } from './us_edgar.mjs';
import { fetchProfile, loadUsEarningsCalendar } from './us_finnhub.mjs';
import {
  returnPct, priceLevelVsRange, usEarningsTrendSignal,
  tenbaggerSignal, nextGenTenbaggerSignal, repricingLagScore, marketCapYen,
} from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'us_tenbagger_cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_GAP = 250;

// smart_entry.mjsのTENBAGGER_MAX_MARKET_CAP_JPY（300億円）・
// us_screener.mjsのTENBAGGER_MAX_MARKET_CAP_USD（$2B）と同じ考え方の
// Tier A（低時価総額）上限。実運用データが無い状態で決めた初期値。
export const US_TENBAGGER_MAX_MARKET_CAP_USD = 2_000; // 百万USD

// 決算日に依存しない手動キュレーションリスト。ユーザー指定の2銘柄から
// 開始。今後のテーマ調査で追記していく（tenbagger_research_log.mdと
// 同じ運用）。
export const US_TENBAGGER_WATCHLIST = [
  { code: 'IONQ', theme: '量子コンピュータ' },
  { code: 'AUR', theme: '自動運転（トラック）' },
];

// us_screener.mjsで実測されたREXR（REIT）のEDGAR売上高タグ不整合バグ
// と同じガード。PSRが非現実的な水準になった場合はデータ不整合として
// null扱いにする。
const MAX_PLAUSIBLE_PSR = 500;

export async function runUsTenbaggerScreen({ today, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 米国株テンバガー候補キャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  // AMBUSHと同じキャッシュを再利用（追加リクエスト無し）。イベント軸
  // （daysToEarnings）の補助情報としてのみ使う。決算日でユニバースを
  // 絞り込むことはしない。
  const calendar = await loadUsEarningsCalendar({ today, horizonDays: 60, force: false });
  const cikMap = await loadTickerCikMap();

  console.log(`🚀 米国株テンバガー候補: ウォッチリスト${US_TENBAGGER_WATCHLIST.length}銘柄をスキャン`);
  const results = [];
  let err = 0;
  for (const w of US_TENBAGGER_WATCHLIST) {
    try {
      await sleep(REQ_GAP);
      const bars = await fetchDailyBars(w.code);
      await sleep(REQ_GAP);
      const profile = await fetchProfile(w.code);

      let trend = [];
      const cik = cikMap[w.code];
      if (cik) {
        await sleep(REQ_GAP);
        const facts = await fetchCompanyFacts(cik);
        trend = extractQuarterlyTrend(facts);
      }
      const earningsTrend = usEarningsTrendSignal(trend, today);

      const marketCap = profile.marketCap ?? null;
      const revenueGrowthPct = earningsTrend.revenueGrowthPct ?? null;
      const withinTierACap = Number.isFinite(marketCap) && marketCap <= US_TENBAGGER_MAX_MARKET_CAP_USD;
      const tenbaggerA = withinTierACap
        ? tenbaggerSignal({ marketCap, maxMarketCap: US_TENBAGGER_MAX_MARKET_CAP_USD, revenueGrowthPct })
        : { level: null, label: null, note: null, checked: true };
      const tenbaggerB = withinTierACap
        ? { level: null, label: null, note: null, checked: true }
        : nextGenTenbaggerSignal({ marketCap, revenueGrowthPct });
      const tier = tenbaggerA.level === 'good' ? 'A' : tenbaggerB.level === 'good' ? 'B' : null;
      if (!tier) continue; // 成長率が閾値未満。ウォッチリストに載せているだけでは候補にしない

      const ttmRevenue = trend.length >= 4
        ? trend.slice(-4).reduce((sum, e) => sum + (Number.isFinite(e.revenue) ? e.revenue : 0), 0)
        : null;
      const psrRaw = Number.isFinite(ttmRevenue) && ttmRevenue > 0 && Number.isFinite(marketCap)
        ? marketCapYen(marketCap) / ttmRevenue
        : null;
      const psr = Number.isFinite(psrRaw) && psrRaw <= MAX_PLAUSIBLE_PSR ? psrRaw : null;

      const repricingLag = repricingLagScore({
        return1m: returnPct(bars.closes, 20),
        return3m: returnPct(bars.closes, 60),
        priceLevelPct: priceLevelVsRange(bars.closes, 60),
        revenueGrowthPct, profitGrowthPct: earningsTrend.netIncomeGrowthPct ?? null,
        per: null, sectorPer: null, psr,
        hasCatalyst: false, // Phase 1の既知の限界（US側にTDnet相当の先行カタリスト検出は無い）
        daysToEarnings: (() => {
          const d = calendar?.stocks?.[w.code]?.earningsDate;
          if (!d) return null;
          return Math.round((new Date(`${d}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
        })(),
      });

      results.push({
        code: w.code, name: profile.name ?? w.code, theme: w.theme,
        industry: profile.industry ?? null, marketCap,
        price: bars.price, changePct: bars.changePct, closes: bars.closes.slice(-20),
        fiftyTwoWeekHigh: bars.fiftyTwoWeekHigh,
        tier, tenbagger: tier === 'A' ? tenbaggerA : tenbaggerB,
        earningsTrend, repricingLag,
      });
    } catch (e) {
      err++;
      console.error(`  ⚠️ ${w.code} 取得失敗: ${e.message}`);
    }
  }
  console.log(`   米国株テンバガー候補スキャン完了（取得失敗 ${err}） / 該当 ${results.length}銘柄`);

  const out = { date: today, universe: US_TENBAGGER_WATCHLIST.length, results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
