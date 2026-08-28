// ==================================================================
// us_screener.mjs — 米国株版AMBUSH（決算前カタリスト先読み、Phase 1）
//
//  screener.mjs（日本株AMBUSH）と同じ2段構成:
//   Stage 1 … Finnhub決算カレンダーでT+14〜45日の銘柄に絞り込み
//             （ここが「全米市場を毎日スキャンしなくて済む」理由）、
//             Yahoo Financeの日足で乖離率・RSI・出来高Zを算出。
//   Stage 2 … Stage1通過銘柄だけSEC EDGARで財務データを取得。
//
//  ■ Phase 1でのスコープ縮小（日本版との違い、計画時に確定済み）
//  - TDnet相当の「好材料開示・月次KPI」の先行カタリスト検出は無い
//    （米国に相当する一元的な適時開示検索サイトが無料で無いため）。
//    そのためevidence（先行カタリストの有無）によるランク制限は行わない。
//  - セクター/業種モメンタムは非対応（Phase 2で検討）。
//  - 期待値のワナ（consensusTrapSignal相当）は米国に「公式通期予想」の
//    開示制度が無いため非対応。代わりにusEarningsTrendSignal（四半期
//    実績の前年同期比トレンド）を使う。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailyBars } from './us_yahoo.mjs';
import { loadTickerCikMap, fetchCompanyFacts, extractBalanceSheetSnapshot, extractQuarterlyTrend } from './us_edgar.mjs';
import { loadUsEarningsCalendar, fetchProfile } from './us_finnhub.mjs';
import {
  kairi, rsi, volumeZScore, stage1, unpricedScore, STAGE1,
  netNetSignal, receivablesAnomalySignal, usEarningsTrendSignal,
} from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'us_ambush_cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_GAP = 250; // Yahoo/EDGARとも十分に余裕を持たせる

// AMBUSHのWINDOW（screener.mjs）と同じ考え方: 決算発表からT+14〜45日を
// 「材料は出たがまだ織り込みが浅い」時間帯とみなす。
export const US_WINDOW = { nowMin: 14, nowMax: 30, watchMin: 31, watchMax: 45 };

// cheapExclusion（indicators.mjs）はJPY建ての閾値（300円・1億円/日）が
// ハードコードされているため米国株には転用できない。ドル建ての初期値
// として置いたもので、実運用データを見てから調整する前提の値。
const US_EXCLUDE = { minPrice: 5, minLiquidityUsd: 2_000_000, liquidityDays: 5 };

function usCheapExclusion({ price, closes, volumes }) {
  const reasons = [];
  if (!Number.isFinite(price)) reasons.push('株価N/A');
  else if (price < US_EXCLUDE.minPrice) reasons.push(`株価$${price} < $${US_EXCLUDE.minPrice}`);
  const n = US_EXCLUDE.liquidityDays;
  if (!closes || !volumes || closes.length < n || volumes.length < n) {
    reasons.push('流動性N/A');
  } else {
    const recentCloses = closes.slice(-n), recentVols = volumes.slice(-n);
    const avgUsd = recentCloses.reduce((sum, c, i) => sum + c * (recentVols[i] ?? 0), 0) / n;
    if (avgUsd < US_EXCLUDE.minLiquidityUsd) {
      reasons.push(`5日平均売買代金$${Math.round(avgUsd).toLocaleString()} < $${US_EXCLUDE.minLiquidityUsd.toLocaleString()}`);
    }
  }
  return { excluded: reasons.length > 0, reasons };
}

function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d1 = new Date(`${today}T00:00:00Z`), d2 = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((d2 - d1) / 86400000);
}

// screener.mjsのAMBUSH_BONUS_FIELDS/AMBUSH_PENALTY_FIELDSと同じ「単一の
// 情報源」パターン。米国版はPhase 1でシグナル数が少ないため2つの配列に
// 分けず、usScoreの計算式に直接持たせる（増えてきたらJP版と同じ配列化を
// 検討する）。
export function usScore({ netNet, receivablesAnomaly, earningsTrend }) {
  let score = 50;
  if (netNet?.level === 'good') score += 15;
  if (earningsTrend?.level === 'good') score += 20;
  if (earningsTrend?.level === 'bad') score -= 15;
  if (receivablesAnomaly?.level === 'bad') score -= 15;
  if (receivablesAnomaly?.level === 'warn') score -= 8;
  return Math.max(0, Math.min(100, score));
}

export const usRankOf = (s) => (s >= 80 ? 'S' : s >= 70 ? 'A' : s >= 60 ? 'B' : s >= 50 ? 'C' : 'D');

export async function runUsScreen({ today, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 米国株AMBUSHキャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  const calendar = await loadUsEarningsCalendar({ today, horizonDays: 60, force });
  if (calendar.degraded) {
    console.error('  ⚠️ 米国株AMBUSH: 決算カレンダーが取得できなかったためスキップします');
    return { date: today, universe: 0, results: [], degraded: true };
  }

  const universe = Object.values(calendar.stocks)
    .map((s) => ({ ...s, daysLeft: daysUntil(s.earningsDate, today) }))
    .filter((s) => s.daysLeft !== null && s.daysLeft >= US_WINDOW.nowMin && s.daysLeft <= US_WINDOW.watchMax);
  console.log(`🎯 米国株AMBUSHユニバース: ${universe.length}銘柄 (T+${US_WINDOW.nowMin}〜T+${US_WINDOW.watchMax})`);
  if (!universe.length) {
    const out = { date: today, universe: 0, results: [] };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
    return out;
  }

  // --- Stage 1: Yahoo Financeで日足を取得し、乖離率・RSI・出来高Zで足切り
  console.log(`🔍 Stage 1: テクニカル足切り (${universe.length}リクエスト)`);
  const survivors = [];
  let s1err = 0, s1excluded = 0;
  for (const s of universe) {
    try {
      const bars = await fetchDailyBars(s.code);
      const excl = usCheapExclusion(bars);
      if (excl.excluded) { s1excluded++; continue; }
      const tech = {
        price: bars.price, changePct: bars.changePct,
        kairi: kairi(bars.price, bars.closes), rsi: rsi(bars.closes), volZ: volumeZScore(bars.volumes),
        closes: bars.closes.slice(-20),
      };
      if (stage1(tech).pass) survivors.push({ ...s, tech });
    } catch {
      s1err++;
    }
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 通過 ${survivors.length}/${universe.length}（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}）`);

  // --- Stage 2: SEC EDGARで財務データを取得
  console.log(`🔬 Stage 2: ファンダ照合 (${survivors.length}銘柄)`);
  const cikMap = await loadTickerCikMap();
  const results = [];
  let s2err = 0;
  for (const s of survivors) {
    const cik = cikMap[s.code];
    let bs = {}, trend = [];
    if (cik) {
      try {
        await sleep(REQ_GAP);
        const facts = await fetchCompanyFacts(cik);
        bs = extractBalanceSheetSnapshot(facts);
        trend = extractQuarterlyTrend(facts);
      } catch {
        s2err++;
      }
    }
    // marketCapはEDGARのfactsに入っていない（貸借対照表の項目ではない）
    // ためFinnhubのprofile2から補う（百万USD単位。indicators.mjsの
    // marketCapYen()はkabutanの「百万円」と同じ「100万単位→生単位」の
    // 変換をするだけで通貨に依存しないため、百万USD単位のまま渡せる）。
    let profile = {};
    try {
      await sleep(REQ_GAP);
      profile = await fetchProfile(s.code);
    } catch { /* marketCap無し→netNetはchecked:falseのまま */ }
    const netNet = netNetSignal({ cash: bs.cash, totalAssets: bs.totalAssets, equity: bs.equity, marketCap: profile.marketCap ?? null, receivables: bs.receivables });
    const earningsTrend = usEarningsTrendSignal(trend, today);
    // 米国は売上債権の伸び率をEDGARの数値からYoYで計算できないため
    // （extractQuarterlyTrendは残高ではなく損益の系列）、Phase 1では
    // receivablesAnomalyはchecked:falseのまま据え置く（Phase 2で残高の
    // 前年同期比を追加する）。
    const receivablesAnomaly = receivablesAnomalySignal({ revenueGrowthPct: null, receivablesGrowthPct: null });

    const score = usScore({ netNet, receivablesAnomaly, earningsTrend });
    results.push({
      code: s.code,
      name: profile.name ?? s.code,
      industry: profile.industry ?? null,
      marketCap: profile.marketCap ?? null,
      earningsDate: s.earningsDate,
      daysLeft: s.daysLeft,
      consensusEpsEstimate: s.consensusEpsEstimate,
      consensusRevenueEstimate: s.consensusRevenueEstimate,
      price: s.tech.price,
      changePct: s.tech.changePct,
      kairi: s.tech.kairi,
      rsi: s.tech.rsi,
      volZ: s.tech.volZ,
      closes: s.tech.closes,
      netNet,
      earningsTrend,
      receivablesAnomaly,
      score,
      rank: usRankOf(score),
      bucket: s.daysLeft <= US_WINDOW.nowMax ? 'NOW' : 'WATCH',
    });
  }
  console.log(`   Stage 2 完了（財務取得失敗 ${s2err}） / 該当 ${results.length}銘柄`);

  results.sort((a, b) => b.score - a.score);
  const out = { date: today, universe: universe.length, results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
