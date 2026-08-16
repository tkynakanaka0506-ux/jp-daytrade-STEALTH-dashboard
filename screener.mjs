// ==================================================================
// screener.mjs — AMBUSH 2段スクリーニング
//
//  Stage 1 … 株価・MA25・乖離率・RSI(14)・出来高Zスコアのみで足切り。
//            「まだ動いていない」ことの確認であって良し悪しの判定ではない。
//            kabuka ページ1枚（1リクエスト）で完結する。
//  Stage 2 … 通過銘柄だけに対して TDnet / 月次 / 進捗率 / 業種 を取りに行く。
//
//  ■ スコアの正規化について
//  仕様書の配点は 月次30 + PR30 + 進捗20 + セクター10 + テクニカル10 = 100。
//  ただし取得できなかった項目を 0点 として扱うと「情報が無い銘柄」が
//  「悪い銘柄」に化けてしまう（仕様書§25はN/Aの数値化を禁じている）。
//  そこで取得できた項目の満点合計を分母にして100点換算し、
//  分母そのものを DATA CONFIDENCE として別に表示する。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchIntraday, fetchMain, fetchFinance, fetchSectorMomentum, sleep, REQ_GAP } from './kabutan.mjs';
import { kairi, rsi, volumeZScore, stage1, unpricedScore, STAGE1 } from './indicators.mjs';
import { evaluate } from './tdnet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'ambush_cache.json');

export const WINDOW = { nowMin: 14, nowMax: 30, watchMin: 31, watchMax: 45 };
export const MAX_WEIGHT = { monthly: 30, pr: 30, progress: 20, sector: 10, technical: 10 };

// ------------------------------------------------------------------
export function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const a = new Date(`${today}T00:00:00Z`);
  const b = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

// 四半期種別 → 通期に対する折返し基準(%)
export function quarterBasis(q = '') {
  if (q.includes('1Q')) return 25;
  if (q.includes('2Q') || q.includes('中間')) return 50;
  if (q.includes('3Q')) return 75;
  if (q.includes('本決算')) return 100;
  return null;
}

// ------------------------------------------------------------------
// 各項目のスコアリング（取得できなければ null を返す）
// ------------------------------------------------------------------

// 月次KPI(30) — TDnetの題名には前年比%が出ないため「開示の有無」までしか
// 判定できない。中身を読まずに満点を与えるのは推測なので、存在確認ぶんの
// 半分を上限とし、中身は N/A として DATA CONFIDENCE に反映する。
export function monthlyScore(ev) {
  if (!ev || ev.score === null) return { value: null, note: '開示なし' };
  if (!ev.hasMonthly) return { value: null, note: '月次開示なし' };
  return { value: 15, note: '月次開示あり（中身はPDF内のためN/A）' };
}

export function prScore(ev) {
  if (!ev || ev.score === null) return { value: null, note: '開示なし' };
  return { value: ev.score, note: ev.negatives.length ? '悪材料あり' : ev.positives.length ? '好材料あり' : '中立' };
}

// 業績進捗(20) — 折返し基準に対する超過分で評価する
export function progressScore(progress, basis) {
  if (progress === null || progress === undefined || basis === null) return { value: null, note: 'N/A' };
  const excess = progress - basis;
  let v;
  if (excess >= 10) v = 20;
  else if (excess >= 5) v = 16;
  else if (excess >= 2) v = 12;
  else if (excess >= -2) v = 8;
  else if (excess >= -10) v = 4;
  else v = 0;
  return { value: v, note: `基準${basis}%に対し${excess > 0 ? '+' : ''}${Math.round(excess * 10) / 10}%` };
}

export function sectorScore(changePct) {
  if (changePct === null || changePct === undefined) return { value: null, note: 'N/A' };
  let v;
  if (changePct >= 2) v = 10;
  else if (changePct >= 1) v = 8;
  else if (changePct >= 0) v = 6;
  else if (changePct >= -1) v = 3;
  else v = 0;
  return { value: v, note: `業種${changePct > 0 ? '+' : ''}${changePct}%` };
}

// ------------------------------------------------------------------
// 合成: 取得できた項目だけで100点換算し、分母を信頼度として返す
// ------------------------------------------------------------------
export function composite(parts) {
  let got = 0, max = 0;
  const detail = {};
  for (const [k, w] of Object.entries(MAX_WEIGHT)) {
    const p = parts[k];
    detail[k] = p;
    if (p && p.value !== null) { got += p.value; max += w; }
  }
  if (max === 0) return { score: null, confidence: 0, detail };
  return {
    score: Math.round((got / max) * 100),
    confidence: Math.round((max / 100) * 100), // 満点合計＝取得できた情報量(%)
    detail,
  };
}

// ------------------------------------------------------------------
// カタリスト必須ゲート
//
//  仕様書の哲学は GOOD CATALYST + UPCOMING EARNINGS + LOW PRICED-IN。
//  ところが実測では Stage 1 通過111銘柄のうち 月次null=110 / PR null=105 で、
//  「進捗+セクター+テクニカル」だけが埋まった銘柄が満点40を100点換算して
//  Sランクに化けていた（71/111がS判定、カタリスト保有は0件）。
//  セクターは同業種の全銘柄で同じ値、テクニカルは乖離率の言い換えなので、
//  この3項目だけでは「先行カタリスト」の根拠にならない。
//
//  そこで TDnet 由来の先行シグナル（好材料の開示 or 月次KPIの開示）が
//  無い銘柄には S/A を与えず、NOW にも入れない。スコアは正規化のまま
//  表示し、根拠不足であることを rank と bucket の側で表現する。
// ------------------------------------------------------------------
export const hasEvidence = (ev) => Boolean(ev && (ev.positives.length > 0 || ev.hasMonthly));

export const rankOf = (s, evidence = true) => {
  if (s === null) return 'N/A';
  const r = s >= 80 ? 'S' : s >= 70 ? 'A' : s >= 60 ? 'B' : s >= 50 ? 'C' : 'D';
  // 先行カタリストが無い銘柄は上位2ランクを与えない（B止まり）
  if (!evidence && (r === 'S' || r === 'A')) return 'B';
  return r;
};

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
export async function runScreen({ today, sbiStocks, disclosures, force = false, stage1Limit = 400 } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 AMBUSHキャッシュ有効 (${today}) — ${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  // --- ユニバース確定 ---------------------------------------------
  const universe = Object.values(sbiStocks)
    .map((s) => {
      const ref = s.earningsDate ?? s.earningsDateApprox;
      return { ...s, daysLeft: daysUntil(ref, today), refDate: ref };
    })
    .filter(
      (s) =>
        ['confirmed', 'estimated'].includes(s.earningsDateStatus) &&
        s.daysLeft !== null &&
        s.daysLeft >= WINDOW.nowMin &&
        s.daysLeft <= WINDOW.watchMax
    )
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, stage1Limit);

  console.log(`🎯 AMBUSHユニバース: ${universe.length}銘柄 (T+${WINDOW.nowMin}〜T+${WINDOW.watchMax})`);
  if (!universe.length) {
    // ユニバースが空でも、SECTION B のスコアリングに業種騰落が要る
    let sectorsOnly = {};
    try { sectorsOnly = await fetchSectorMomentum(); } catch { /* 失敗時はN/A */ }
    const out = { date: today, universe: 0, passed: 0, results: [], stage1: STAGE1, sectors: sectorsOnly };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
    return out;
  }

  // --- Stage 1 ----------------------------------------------------
  console.log(`🔍 Stage 1: テクニカル足切り (${universe.length}リクエスト)`);
  const survivors = [];
  let s1err = 0;
  for (const [i, s] of universe.entries()) {
    try {
      const iv = await fetchIntraday(s.code);
      const t = {
        price: iv.price,
        changePct: iv.changePct,
        kairi: kairi(iv.price, iv.closes),
        rsi: rsi(iv.closes),
        volZ: volumeZScore(iv.volumes),
        closes: iv.closes,
        vol: iv.vol,
      };
      const v = stage1(t);
      if (v.pass) survivors.push({ ...s, tech: t });
    } catch (e) {
      s1err++;
    }
    if ((i + 1) % 50 === 0) console.log(`   … ${i + 1}/${universe.length} 通過${survivors.length}`);
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 通過 ${survivors.length}/${universe.length}（取得失敗 ${s1err}）`);

  // --- セクター騰落（3リクエスト・全銘柄で共用）------------------
  let sectors = {};
  try {
    sectors = await fetchSectorMomentum();
  } catch (e) {
    console.error(`  ⚠️ 業種別騰落の取得失敗: ${e.message}`);
  }

  // --- Stage 2 ----------------------------------------------------
  console.log(`🔬 Stage 2: ファンダ照合 (${survivors.length}銘柄 × 2リクエスト)`);
  const results = [];
  for (const s of survivors) {
    let main = {}, fin = {};
    try {
      await sleep(REQ_GAP);
      main = await fetchMain(s.code);
      await sleep(REQ_GAP);
      fin = await fetchFinance(s.code);
    } catch (e) {
      console.error(`  ⚠️ ${s.code} Stage2失敗: ${e.message}`);
    }

    const ev = evaluate(disclosures[s.code] ?? []);
    const sec = main.sectorName ? sectors[main.sectorName] : null;

    // 進捗率はSBIの達成率（対通期で統一）を優先し、無ければkabutanの進捗率を使う
    const useSbi = s.achievedRate !== null && s.achievedRate !== undefined;
    const progress = useSbi ? s.achievedRate : fin.progress ?? null;
    const basis = useSbi ? quarterBasis(s.quarter) : fin.progressBasis ?? null;

    const parts = {
      monthly: monthlyScore(ev),
      pr: prScore(ev),
      progress: progressScore(progress, basis),
      sector: sectorScore(sec?.changePct ?? null),
      technical: { value: unpricedScore(s.tech.kairi), note: `乖離${s.tech.kairi}%` },
    };
    const { score, confidence, detail } = composite(parts);
    const evidence = hasEvidence(ev);

    results.push({
      code: s.code,
      name: s.name,
      earningsDate: s.earningsDate,
      earningsDateRaw: s.earningsDateRaw,
      earningsDateStatus: s.earningsDateStatus,
      earningsDateSource: s.earningsDateSource,
      earningsDateRetrievedAt: s.earningsDateRetrievedAt,
      daysLeft: s.daysLeft,
      quarter: s.quarter,
      estimateProfit: s.estimateProfit,
      consensusProfit: s.consensusProfit,
      price: s.tech.price,
      changePct: s.tech.changePct,
      kairi: s.tech.kairi,
      rsi: s.tech.rsi,
      volZ: s.tech.volZ,
      closes: s.tech.closes?.slice(-20) ?? [],
      sectorName: main.sectorName ?? null,
      sectorChangePct: sec?.changePct ?? null,
      loanRatio: main.loanRatio ?? null,
      per: main.per ?? null,
      progress,
      progressBasis: basis,
      progressSource: useSbi ? 'sbi' : 'kabutan',
      catalysts: ev.positives.map((p) => ({ label: p.label, date: p.date, title: p.title })),
      warnings: ev.negatives.map((p) => ({ label: p.label, date: p.date, title: p.title })),
      ambiguous: ev.ambiguous.length,
      hasMonthly: ev.hasMonthly,
      score,
      rank: rankOf(score, evidence),
      confidence,
      evidence,
      detail,
      bucket:
        s.daysLeft >= WINDOW.nowMin && s.daysLeft <= WINDOW.nowMax
          ? (s.earningsDateStatus === 'confirmed' && score !== null && score >= 70 && evidence ? 'NOW' : 'NEAR')
          : 'WATCH',
    });
  }

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const out = {
    date: today,
    universe: universe.length,
    passed: survivors.length,
    stage1: STAGE1,
    sectors, // SECTION B のスコアリングでも使い回す（再取得しない）
    results,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ AMBUSH: NOW ${results.filter((r) => r.bucket === 'NOW').length} / WATCH ${results.filter((r) => r.bucket === 'WATCH').length} / 圏外 ${results.filter((r) => r.bucket === 'NEAR').length}`);
  return out;
}
