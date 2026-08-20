// ==================================================================
// smart_entry.mjs — 「スマート・エントリー」全銘柄スキャン
//
//  決算スケジュールを無視し、需給と乖離だけで機械的にスクリーニングする。
//  AMBUSHのユニバース（SBI決算カレンダーのT+14〜45日以内）とは独立。
//
//  ■ 対象ユニバース
//  東証の全銘柄マスタは保有していないため、TDnet直近14営業日の開示銘柄
//  （実測: 約3,400銘柄）∪ SBI決算カレンダー銘柄（約270銘柄）の和集合を
//  ユニバースとする。開示が全く無い超小型株は漏れうるが、東証上場の
//  大半をカバーできる（仕様書の「全3,800銘柄」に近似）。
//
//  ■ 2段スクリーニング（AMBUSHと同じ考え方）
//  Stage 1 … 全ユニバースを kabuka ページ1枚(1リクエスト)で取得し、
//            低位株・薄商い銘柄を除外した上でパターン①②の技術条件
//            （乖離・RSI・GC・出来高倍率）だけで仮判定する。
//            週次信用残・決算はまだ取らない。
//  Stage 2 … Stage1候補 ∪ コンセンサスを持つSBI銘柄だけに絞って、
//            週次信用残ページ・決算ページ(2リクエスト)を追加取得し、
//            赤字・債務超過を除外した上で3パターンを確定判定する。
//            ここで全銘柄に手を広げるとリクエストが膨れるため、
//            候補を絞ってから叩く。
//
//  ■ 除外フィルター（「一切表示しない」対象）
//  株価300円未満・直近5日平均売買代金1億円未満・直近営業損益が赤字・
//  自己資本比率0%以下（債務超過）のいずれかに該当する銘柄は候補から
//  除く（indicators.mjsのcheapExclusion/fundamentalExclusion）。
//  25日線乖離率+15%超（過熱）やグロース市場の急騰は除外ではなく
//  警告バッジ（scraper.mjs側で付与）。
//
//  ■ パターン③（しこり解消・出遅れ株）の限界
//  コンセンサス予想はSBI決算カレンダーに載っている銘柄（次回決算が
//  近い銘柄）にしか無い。全銘柄分の予想コンセンサスは保有していない
//  ため、パターン③はSBIカレンダー外の銘柄では常にN/A（非該当）になる。
//  推測で埋めない（仕様書§25と同じ方針）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchIntraday, fetchWeeklyCredit, fetchFinance, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, goldenCross, volumeRatio, creditTrend, creditLevelVsRange,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal,
  cheapExclusion, fundamentalExclusion,
} from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'smart_entry_cache.json');

// 表示上限。仕様（新提案）は「毎日10個ほど」だが、複数該当時に何件
// 切り捨てたか分かるよう少し余裕を持たせる。
export const RESULT_LIMIT = 24;

// ------------------------------------------------------------------
// ユニバース構築 — TDnetの開示銘柄 ∪ SBI決算カレンダー銘柄
// ------------------------------------------------------------------
export function buildUniverse({ tdNames = {}, sbiStocks = {} } = {}) {
  const universe = {};
  for (const [code, name] of Object.entries(tdNames)) universe[code] = name;
  for (const [code, s] of Object.entries(sbiStocks)) universe[code] ??= s.name;
  return universe;
}

// Stage 1 の安価な部分判定 — 週次信用残を取らずに分かる範囲だけで
// パターン①②の「技術条件が満たされているか」を仮判定する。
// （パターン③は信用残水準が要るのでここでは判定できない）
function cheapCandidate(tech) {
  const p1 = tech.kairi !== null && tech.rsi !== null && tech.kairi <= -10 && tech.rsi <= 30;
  const p2 = tech.cross?.crossed === true && tech.volRatio !== null && tech.volRatio >= 1.5;
  return p1 || p2;
}

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
export async function runSmartEntryScreen({ today, tdNames, sbiStocks, force = false, limit = RESULT_LIMIT } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 スマート・エントリーキャッシュ有効 (${today}) — 該当${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  const universe = buildUniverse({ tdNames, sbiStocks });
  const codes = Object.keys(universe);
  console.log(`🌐 スマート・エントリー Stage 1: 全${codes.length}銘柄をスキャン（30〜40分程度かかります）`);

  const techByCode = {};
  const stage2Set = new Set();
  let s1err = 0, s1excluded = 0;

  for (const [i, code] of codes.entries()) {
    try {
      const iv = await fetchIntraday(code);
      // 低位株・薄商い銘柄は候補にすら上げない（「ゴミ箱排除」フィルター）。
      // ここで弾けば週次信用残ページ(Stage2)への無駄打ちも防げる。
      const excl = cheapExclusion({ price: iv.price, closes: iv.closes, volumes: iv.volumes });
      if (excl.excluded) { s1excluded++; }
      else {
        const tech = {
          price: iv.price,
          changePct: iv.changePct,
          closes: iv.closes,
          volumes: iv.volumes,
          market: iv.market,
          kairi: kairi(iv.price, iv.closes),
          rsi: rsi(iv.closes),
          cross: goldenCross(iv.closes),
          volRatio: volumeRatio(iv.volumes),
        };
        techByCode[code] = tech;
        if (cheapCandidate(tech)) stage2Set.add(code);
      }
    } catch {
      s1err++;
    }
    if ((i + 1) % 200 === 0) console.log(`   … ${i + 1}/${codes.length}（Stage2候補 ${stage2Set.size} / 除外 ${s1excluded} / 取得失敗 ${s1err}）`);
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 完了（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}） / Stage2候補 ${stage2Set.size}`);

  // パターン③はコンセンサスを持つSBI銘柄でしか判定できない（上記コメント参照）。
  // Stage 1 は universe = tdNames ∪ sbiStocks を全走査済みなので techByCode に
  // 既に入っているはず。取得に失敗していた場合は techByCode[code] が無く、
  // 下のループで自然に除外される。
  for (const [code, s] of Object.entries(sbiStocks)) {
    if (Number.isFinite(s.estimateProfit) && Number.isFinite(s.consensusProfit) && techByCode[code]) {
      stage2Set.add(code);
    }
  }

  console.log(`🔬 スマート・エントリー Stage 2: 週次信用残・決算を確認 (${stage2Set.size}銘柄 × 2リクエスト)`);
  const results = [];
  let s2err = 0, s2excluded = 0;
  for (const code of stage2Set) {
    const tech = techByCode[code];
    if (!tech) continue;
    let weekly = [], fin = {};
    try {
      weekly = await fetchWeeklyCredit(code);
      await sleep(REQ_GAP);
      fin = await fetchFinance(code);
    } catch {
      s2err++;
    }

    // 赤字・債務超過は決算ページを見ないと分からないのでここで弾く。
    const fexcl = fundamentalExclusion({ latestOpProfit: fin.latestOpProfit, equityRatio: fin.equityRatio });
    if (fexcl.excluded) { s2excluded++; await sleep(REQ_GAP); continue; }

    const creditTrendPct = creditTrend(weekly);
    const creditLevelPct = creditLevelVsRange(weekly);
    const loanRatio = weekly[0]?.loanRatio ?? null;
    const s = sbiStocks[code] ?? {};

    const sig1 = reboundPatternSignal({ kairi: tech.kairi, rsi: tech.rsi, creditTrendPct });
    const sig2 = trendReversalPatternSignal({ cross: tech.cross, volRatio: tech.volRatio, loanRatio });
    const sig3 = laggingPatternSignal({
      creditLevelPct, estimateProfit: s.estimateProfit ?? null, consensusProfit: s.consensusProfit ?? null, kairi: tech.kairi,
    });

    const matched = [sig1.level === 'good', sig2.level === 'good', sig3.level === 'good'].filter(Boolean).length;

    if (matched > 0) {
      results.push({
        code,
        name: universe[code] ?? code,
        price: tech.price,
        changePct: tech.changePct,
        closes: tech.closes.slice(-20),
        kairi: tech.kairi,
        rsi: tech.rsi,
        cross: tech.cross,
        volRatio: tech.volRatio,
        market: tech.market ?? null,
        loanRatio,
        creditTrendPct,
        creditLevelPct,
        estimateProfit: s.estimateProfit ?? null,
        consensusProfit: s.consensusProfit ?? null,
        matched,
        sig1, sig2, sig3,
      });
    }
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 2 完了（取得失敗 ${s2err} / 赤字・債務超過除外 ${s2excluded}） / 該当 ${results.length}銘柄`);

  // 該当パターン数が多い順、次に乖離が深い（＝より仕込み時に近い）順
  results.sort((a, b) => b.matched - a.matched || (a.kairi ?? 999) - (b.kairi ?? 999));
  const shown = results.slice(0, limit);
  const dropped = results.length - shown.length;
  if (dropped > 0) console.log(`   ⚠️ 表示上限${limit}件のため ${dropped}銘柄を切り捨て（該当は${results.length}件）`);

  const out = {
    date: today,
    universe: codes.length,
    stage2: stage2Set.size,
    matched: results.length,
    dropped,
    results: shown,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
