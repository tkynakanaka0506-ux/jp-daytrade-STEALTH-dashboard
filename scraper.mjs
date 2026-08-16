// ==================================================================
// STEALTH v7.1 "AMBUSH"
//
//  v7.0（kabutan単一ソースのfetchエンジン）に、決算前の先行カタリストを
//  探す AMBUSH スクリーニングを追加したもの。
//
//  GOOD CATALYST + UPCOMING EARNINGS + LOW PRICED-IN = AMBUSH
//
//  ■ データソース
//   決算予定日  : SBI証券 決算発表スケジュール（実体はIRISのJSONP・公開API）
//   適時開示    : TDnet（ルールベース判定。LLM APIは使わない）
//   株価/指標   : kabutan（kabukaページ1枚で価格・30日終値・出来高）
//   業種騰落    : kabutan 東証【業種別】騰落ランキング（3リクエスト）
//   ※ Yahoo Finance は実測でIP単位の429、stooq はJS challenge のため不使用
//
//  ■ 1日のリクエスト数（実測）
//   SBI決算カレンダー   … 約32
//   TDnet 14営業日      … 約90
//   Stage 1（ユニバース）… 約250
//   Stage 2（通過銘柄）  … 通過数 × 2
//   いずれも日次キャッシュ。場中の5分更新では 0件。
//   場中は SECTION A の上位と SECTION B のみを再取得する。
//
//  実行:
//    node scraper.mjs                通常
//    node scraper.mjs --force        日次キャッシュを強制再取得
//    node scraper.mjs --no-open      ブラウザを開かない（自動実行向け）
//    node scraper.mjs --market-hours 場外なら即終了（launchd向け）
//    node scraper.mjs --daily-only   日次パートだけ流す（寄り前バッチ用）
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import { fetchIntraday, fetchMain, fetchFinance, sleep, REQ_GAP } from './kabutan.mjs';
import { kairi, rsi, volumeZScore, unpricedScore } from './indicators.mjs';
import { loadEarningsCalendar } from './sbi.mjs';
import { loadDisclosures, evaluate } from './tdnet.mjs';
import {
  runScreen, daysUntil, quarterBasis, monthlyScore, prScore,
  progressScore, sectorScore, composite, rankOf, hasEvidence, WINDOW,
} from './screener.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'kabutan_cache.json');
const OUT_FILE = path.join(__dirname, 'index.html');

const FORCE = process.argv.includes('--force');
const NO_OPEN = process.argv.includes('--no-open');
const MARKET_HOURS_ONLY = process.argv.includes('--market-hours');
const DAILY_ONLY = process.argv.includes('--daily-only');

// 場中に価格を再取得する AMBUSH 銘柄数。
// 全通過銘柄を5分ごとに叩くとリクエストが膨らむので上位のみに絞る。
const AMBUSH_LIVE = 12;

// SECTION C に並べる監視候補の上限。Stage 1 通過は100銘柄を超えることが
// あるので、全部出すと画面が使い物にならない。
const AMBUSH_WATCH_MAX = 24;

function isMarketHours() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const day = jst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 50;
}

// ------------------------------------------------------------------
// 多重起動の防止
//
//  日次ジョブ(寄り前)と場中ジョブ(5分間隔)は本来ぶつからないが、
//  Macがスリープしていて寄り前ジョブが起床時に走ると、場中ジョブと
//  同時に動く可能性がある。両方が同じキャッシュを書くと壊れるので、
//  PIDロックで後発を降ろす。
//  ・記録されたPIDが生きていれば降りる
//  ・プロセスが死んでいる or 30分以上古いロックは奪う（異常終了対策）
// ------------------------------------------------------------------
const LOCK_FILE = path.join(__dirname, '.scraper.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

function acquireLock() {
  // 'wx' は「存在しなければ作る、あれば失敗」をOSレベルで不可分に行う。
  // readFileSync→writeFileSync の順で書くと、同時起動した全プロセスが
  // 「ロック無し」を同時に観測して全員が通ってしまう（実測で3本とも通過）。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // 既にロックがある。持ち主が生きているか調べる。
      let stale = true;
      try {
        const pid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
        const ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (ageMs < LOCK_STALE_MS && Number.isFinite(pid)) {
          try {
            process.kill(pid, 0); // シグナル0＝存在確認のみ。送信はしない
            stale = false;        // 生きている
          } catch { /* 死んでいる */ }
        }
      } catch { /* 読めない＝壊れている → 奪ってよい */ }

      if (!stale) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 他が先に消した */ }
      // 1度だけ取り直しを試す
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 既に消えている */ }
}

// ==================================================================
// CONFIG
//   earningsDate のハードコードは廃止（仕様書§2）。SBIから取得する。
// ==================================================================
const WATCHLIST = [
  { code: '6981', name: '村田製作所' },
  { code: '6758', name: 'ソニーG' },
  { code: '6902', name: 'デンソー' },
  { code: '6752', name: 'パナソニック' },
  { code: '6753', name: 'シャープ' },
  { code: '7752', name: 'リコー' },
  { code: '8002', name: '丸紅' },
];

// ==================================================================
// ユーティリティ
// ==================================================================
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = (v, u = '') => (v === null || v === undefined ? '--' : `${v}${u}`);

// ==================================================================
// SECTION B（ウォッチリスト）の日次データ
//   業種・信用倍率・PER・進捗率。SBIの達成率が取れる銘柄はそちらを優先。
// ==================================================================
async function loadWatchlistDaily(codes) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }

  const today = todayJST();
  const fresh = cache.date === today && !FORCE;
  if (fresh && codes.every((c) => cache.data?.[c])) {
    console.log(`💾 ウォッチリスト日次キャッシュ有効 (${today}) — リクエスト0件`);
    return cache.data;
  }

  const data = fresh ? { ...cache.data } : {};
  const todo = codes.filter((c) => !data[c]);
  console.log(`🌐 ウォッチリスト日次取得 (${todo.length}銘柄 × 2ページ)`);
  for (const code of todo) {
    try {
      const main = await fetchMain(code);
      await sleep(REQ_GAP);
      const fin = await fetchFinance(code);
      data[code] = { ...main, ...fin };
    } catch (e) {
      console.error(`  ⚠️ ${code} 日次取得失敗: ${e.message}`);
      data[code] = { loanRatio: null, per: null, sectorName: null, progress: null, progressBasis: null };
    }
    await sleep(REQ_GAP);
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ date: today, data }, null, 2));
  return data;
}

// ==================================================================
// 描画パーツ
// ==================================================================
function generateSparkline(closes, id) {
  if (!closes || closes.length < 5) return '';
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const [w, h] = [150, 40];
  const xy = closes.map((v, i) => [
    (i / (closes.length - 1)) * w,
    h - ((v - min) / range) * (h - 6) - 3,
  ]);
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = closes.at(-1) >= closes[0];
  const color = up ? '#22ffc4' : '#ff3d71';
  const [lx, ly] = xy.at(-1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".38"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="0,${h} ${pts} ${w},${h}" fill="url(#g${id})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"
              stroke-linejoin="round" stroke-linecap="round" filter="drop-shadow(0 0 4px ${color})"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="${color}">
      <animate attributeName="r" values="2.6;4.6;2.6" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;.35;1" dur="2s" repeatCount="indefinite"/>
    </circle>
  </svg>`;
}

function scoreGauge(prob) {
  if (prob === null) {
    return `<svg class="gauge" width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r="26" fill="none" stroke="#1d2735" stroke-width="4"/>
      <text x="34" y="33" text-anchor="middle" class="gauge-v" fill="#7d90ad">N/A</text>
      <text x="34" y="45" text-anchor="middle" class="gauge-u">NO DATA</text>
    </svg>`;
  }
  const r = 26, c = 2 * Math.PI * r;
  const hue = prob >= 80 ? '#22ffc4' : prob >= 70 ? '#31e0ff' : prob >= 60 ? '#4d9fff' : prob >= 50 ? '#ffb43d' : '#ff3d71';
  return `<svg class="gauge" width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r="${r}" fill="none" stroke="#1d2735" stroke-width="4"/>
      <circle cx="34" cy="34" r="${r}" fill="none" stroke="${hue}" stroke-width="4"
              stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}"
              stroke-dashoffset="${(c * (1 - prob / 100)).toFixed(1)}"
              transform="rotate(-90 34 34)" filter="drop-shadow(0 0 5px ${hue})"/>
      <text x="34" y="33" text-anchor="middle" class="gauge-v" fill="${hue}">${prob}</text>
      <text x="34" y="45" text-anchor="middle" class="gauge-u">SCORE</text>
  </svg>`;
}

// 決算日の確度をそのままバッジにする（推測で「確定」と言わない）
function earningsBadge(r) {
  if (r.earningsDateStatus === 'confirmed') {
    return `<span class="chip cyan" title="取引所発表の確定日 (${esc(r.earningsDateSource ?? '')})">決算 T-${r.daysLeft}d · 確定</span>`;
  }
  if (r.earningsDateStatus === 'estimated') {
    return `<span class="chip amber" title="前年同期の発表日を置き換えた参考値 (${esc(r.earningsDateRaw ?? '')})">決算 T-${r.daysLeft}d · 参考値</span>`;
  }
  return `<span class="chip gray" title="SBIの予定表（約2ヶ月先まで）に次回決算日が未掲載">決算日 未確定</span>`;
}

const kairiTone = (k) => (k === null ? '' : k < 0 ? 'up' : k > 5 ? 'down' : '');
const rsiTone = (v) => (v === null ? '' : v > 70 ? 'down' : v < 40 ? 'up' : '');
const volZTone = (v) => (v === null ? '' : v > 2 ? 'down' : v < 0 ? 'up' : '');
const progressTone = (p, basis) => {
  if (p === null || basis === null) return '';
  const excess = p - basis;
  return excess >= 5 ? 'up' : excess < -10 ? 'down' : '';
};

function card(r, i, opts = {}) {
  const rankCls = r.rank === 'S' ? 's-rank' : r.rank === 'A' ? 'a-rank' : '';
  const catalystChips = (r.catalysts ?? []).slice(0, 3)
    .map((c) => `<span class="chip mint" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');
  const warnChips = (r.warnings ?? []).slice(0, 2)
    .map((c) => `<span class="chip red" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');

  return `
      <article class="card ${rankCls}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            <span class="code">${esc(r.code)}</span>
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${scoreGauge(r.score)}
        </header>

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="stats">
          <div class="cell"><span class="k">乖離率<i>未織込 ${fmt(unpricedScore(r.kairi), '/10')}</i></span><span class="v ${kairiTone(r.kairi)}">${fmt(r.kairi, '%')}</span></div>
          <div class="cell"><span class="k">RSI<i>14日</i></span><span class="v ${rsiTone(r.rsi)}">${fmt(r.rsi)}</span></div>
          <div class="cell"><span class="k">出来高Z<i>20日</i></span><span class="v ${volZTone(r.volZ)}">${fmt(r.volZ)}</span></div>
          <div class="cell"><span class="k">進捗<i>${r.progressBasis === null ? '基準N/A' : `基準${r.progressBasis}% · ${r.progressSource === 'sbi' ? 'SBI' : '株探'}`}</i></span><span class="v ${progressTone(r.progress, r.progressBasis)}">${fmt(r.progress, '%')}</span></div>
        </div>

        <div class="meta">
          <span>${esc(r.sectorName ?? '業種N/A')} ${r.sectorChangePct !== null && r.sectorChangePct !== undefined ? `<b class="${r.sectorChangePct >= 0 ? 'up' : 'down'}">${r.sectorChangePct > 0 ? '+' : ''}${r.sectorChangePct}%</b>` : ''}</span>
          <span>信用 ${fmt(r.loanRatio, '倍')}</span>
          <span>PER ${fmt(r.per, '倍')}</span>
          <span class="conf" title="スコア算出に使えた情報量。100%＝月次/PR/進捗/セクター/テクニカルが全て取得できた状態">DATA ${r.confidence ?? 0}%</span>
        </div>

        <footer class="c-foot">
          ${catalystChips}${warnChips}
          ${earningsBadge(r)}
          ${r.ambiguous ? `<span class="chip gray" title="「業績予想の修正」等、題名から上方/下方が判別できない開示">方向不明 ${r.ambiguous}</span>` : ''}
          ${r.hasMonthly ? '<span class="chip flat" title="月次開示あり。前年比の数値はPDF内のため未取得">月次あり</span>' : ''}
          ${r.evidence === false ? '<span class="chip gray" title="TDnetに好材料の開示も月次KPIも無いため、先行カタリストの根拠がありません。スコアが高くてもS/Aランクは付けず、AMBUSH NOWにも入れていません">先行材料なし</span>' : ''}
          ${opts.stale ? '<span class="chip gray">日次値</span>' : ''}
        </footer>
      </article>`;
}

const section = (id, icon, title, desc, cards, empty) => `
  <section class="sec" id="${id}">
    <div class="sec-head">
      <h2><span class="ico">${icon}</span>${title}</h2>
      <p>${desc}</p>
    </div>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">${empty}</div>`}
  </section>`;

// ==================================================================
// メイン
// ==================================================================
async function main() {
  const t0 = Date.now();
  if (MARKET_HOURS_ONLY && !isMarketHours()) {
    console.log(`⏸  場外のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
    return;
  }
  // 場外判定の「後」にロックを取る。場外スキップは一瞬なので競合しない。
  if (!acquireLock()) {
    console.log(`⏸  別のインスタンスが実行中のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
    return;
  }
  console.log('🚀 STEALTH v7.1 "AMBUSH" 起動');
  const today = todayJST();

  // ---- 日次パート（キャッシュ）------------------------------------
  const sbi = await loadEarningsCalendar({
    today,
    horizonDays: 60,
    extraCodes: WATCHLIST.map((s) => s.code),
    force: FORCE,
  });
  const td = await loadDisclosures({ today, days: 14, force: FORCE });
  const amb = await runScreen({ today, sbiStocks: sbi.stocks, disclosures: td.byCode, force: FORCE });
  const daily = await loadWatchlistDaily(WATCHLIST.map((s) => s.code));
  const sectors = amb.sectors ?? {};

  if (DAILY_ONLY) {
    console.log(`✅ 日次パート完了 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    return;
  }

  // ---- SECTION B: ウォッチリスト（毎回更新）------------------------
  const watch = [];
  let macro = { nikkei: null, usdjpy: null };
  for (const stock of WATCHLIST) {
    try {
      const iv = await fetchIntraday(stock.code);
      if (iv.macro.nikkei) macro = iv.macro;

      const d = daily[stock.code] ?? {};
      const s = sbi.stocks[stock.code] ?? {};
      const ev = evaluate(td.byCode[stock.code] ?? []);
      const sec = d.sectorName ? sectors[d.sectorName] : null;

      // 進捗率はSBIの達成率（四半期種別と整合した対通期）を優先
      const useSbi = s.achievedRate !== null && s.achievedRate !== undefined;
      const progress = useSbi ? s.achievedRate : d.progress ?? null;
      const basis = useSbi ? quarterBasis(s.quarter) : d.progressBasis ?? null;

      const k = kairi(iv.price, iv.closes);
      const parts = {
        monthly: monthlyScore(ev),
        pr: prScore(ev),
        progress: progressScore(progress, basis),
        sector: sectorScore(sec?.changePct ?? null),
        technical: { value: unpricedScore(k), note: `乖離${k}%` },
      };
      const { score, confidence } = composite(parts);
      const ref = s.earningsDate ?? s.earningsDateApprox;

      watch.push({
        code: stock.code,
        name: stock.name,
        price: iv.price,
        changePct: iv.changePct,
        closes: iv.closes.slice(-20),
        kairi: k,
        rsi: rsi(iv.closes),
        volZ: volumeZScore(iv.volumes),
        sectorName: d.sectorName ?? null,
        sectorChangePct: sec?.changePct ?? null,
        loanRatio: d.loanRatio ?? null,
        per: d.per ?? null,
        progress,
        progressBasis: basis,
        progressSource: useSbi ? 'sbi' : 'kabutan',
        earningsDateStatus: s.earningsDateStatus ?? 'unknown',
        earningsDateSource: s.earningsDateSource ?? null,
        earningsDateRaw: s.earningsDateRaw ?? null,
        daysLeft: s.earningsDateStatus === 'unknown' ? null : daysUntil(ref, today),
        catalysts: ev.positives.map((p) => ({ label: p.label, date: p.date, title: p.title })),
        warnings: ev.negatives.map((p) => ({ label: p.label, date: p.date, title: p.title })),
        ambiguous: ev.ambiguous.length,
        hasMonthly: ev.hasMonthly,
        score,
        rank: rankOf(score, hasEvidence(ev)),
        confidence,
        evidence: hasEvidence(ev),
      });
    } catch (e) {
      console.error(`  ⚠️ ${stock.code} ${stock.name}: ${e.message}`);
    }
    await sleep(REQ_GAP);
  }

  // ---- SECTION A / C: AMBUSH（上位のみ場中も価格更新）---------------
  // NOW = 先行カタリストありの本命。
  // SECTION C には T+31〜45(WATCH) だけでなく、NOW条件を満たさなかった
  // T+14〜30(NEAR) も入れる。ゲートで落ちた銘柄を画面から消してしまうと
  // 「Stage 1 を通過した銘柄が何だったのか」が追えなくなるため。
  // 先行カタリストを持つものを上に、次にスコア順。
  const now = amb.results.filter((r) => r.bucket === 'NOW');
  const later = amb.results
    .filter((r) => r.bucket !== 'NOW')
    .sort((a, b) => (b.evidence === true) - (a.evidence === true) || (b.score ?? -1) - (a.score ?? -1))
    .slice(0, AMBUSH_WATCH_MAX);
  const live = [...now, ...later].slice(0, AMBUSH_LIVE);
  if (live.length) {
    console.log(`🔄 AMBUSH上位${live.length}銘柄の価格を更新`);
    for (const r of live) {
      try {
        const iv = await fetchIntraday(r.code);
        r.price = iv.price;
        r.changePct = iv.changePct;
        r.closes = iv.closes.slice(-20);
        r.kairi = kairi(iv.price, iv.closes);
        r.rsi = rsi(iv.closes);
        r.volZ = volumeZScore(iv.volumes);
        r.live = true;
      } catch (e) {
        console.error(`  ⚠️ ${r.code} 価格更新失敗: ${e.message}`);
      }
      await sleep(REQ_GAP);
    }
  }

  if (!watch.length && !amb.results.length) {
    console.error('❌ 1銘柄も取得できませんでした。index.html は更新しません。');
    process.exit(1);
  }

  const caution = macro.usdjpy !== null && macro.usdjpy < 145;
  const readout = (label, value, unit = '', cls = '') =>
    `<div class="ro"><span class="ro-k">${label}</span><span class="ro-v ${cls}">${value}<i>${unit}</i></span></div>`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="60">
<title>STEALTH v7.1 AMBUSH</title>
<style>
  :root{
    --bg:#05070d; --panel:rgba(17,24,38,.62); --line:rgba(90,130,190,.20);
    --txt:#e6f0ff; --dim:#7d90ad; --cyan:#31e0ff; --mint:#22ffc4;
    --rose:#ff3d71; --amber:#ffb43d; --blue:#4d9fff;
    --mono:"SF Mono",'JetBrains Mono',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}

  body{
    background:var(--bg); color:var(--txt); min-height:100vh; padding:32px 28px 48px;
    font-family:"Helvetica Neue","Hiragino Sans","Noto Sans JP",sans-serif;
    -webkit-font-smoothing:antialiased; position:relative; overflow-x:hidden;
  }
  body::before{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background:
      radial-gradient(900px 600px at 12% -10%, rgba(49,224,255,.13), transparent 60%),
      radial-gradient(800px 520px at 92% 4%, rgba(124,77,255,.13), transparent 62%),
      radial-gradient(700px 700px at 50% 115%, rgba(34,255,196,.07), transparent 60%);
  }
  body::after{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;
    background-image:linear-gradient(rgba(90,140,200,.055) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(90,140,200,.055) 1px,transparent 1px);
    background-size:46px 46px;
    mask-image:radial-gradient(circle at 50% 30%,#000 30%,transparent 82%);
  }
  .wrap{position:relative;z-index:1;max-width:1560px;margin:0 auto}

  .top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px}
  .brand{display:flex;align-items:center;gap:14px}
  .logo{width:38px;height:38px;border:1px solid rgba(49,224,255,.5);border-radius:9px;
        display:grid;place-items:center;background:rgba(49,224,255,.07);
        box-shadow:0 0 22px rgba(49,224,255,.28) inset,0 0 18px rgba(49,224,255,.14)}
  .logo span{font:700 15px/1 var(--mono);color:var(--cyan)}
  h1{font-size:20px;font-weight:600;letter-spacing:.16em}
  h1 b{color:var(--cyan);font-weight:600}
  .sub{font:400 10.5px/1 var(--mono);color:var(--dim);letter-spacing:.24em;margin-top:6px}
  .live{display:flex;align-items:center;gap:7px;font:500 10.5px/1 var(--mono);
        color:var(--mint);letter-spacing:.18em}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--mint);
       box-shadow:0 0 9px var(--mint);animation:blink 1.9s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.8)}}

  .hud{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--line);border-radius:13px;
       background:linear-gradient(180deg,rgba(20,29,46,.8),rgba(11,17,29,.62));
       backdrop-filter:blur(9px);overflow:hidden;margin-bottom:26px;
       border-left:2px solid ${caution ? 'var(--rose)' : 'var(--mint)'}}
  .ro{flex:1;min-width:150px;padding:14px 20px;border-right:1px solid var(--line)}
  .ro:last-child{border-right:0}
  .ro-k{display:block;font:500 9.5px/1 var(--mono);color:var(--dim);letter-spacing:.2em;margin-bottom:7px}
  .ro-v{font:600 20px/1 var(--mono);color:var(--txt);letter-spacing:.01em}
  .ro-v i{font-style:normal;font-size:11px;color:var(--dim);margin-left:3px}

  /* ── セクション ── */
  .sec{margin-bottom:34px}
  .sec-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:15px;
            padding-bottom:11px;border-bottom:1px solid var(--line)}
  .sec-head h2{font-size:15px;font-weight:600;letter-spacing:.13em;display:flex;align-items:center;gap:9px}
  .ico{font-size:15px}
  .sec-head p{font:400 10.5px/1.6 var(--mono);color:var(--dim);letter-spacing:.06em}
  .empty{padding:26px 22px;border:1px dashed var(--line);border-radius:12px;
         font:400 11.5px/1.8 var(--mono);color:var(--dim);background:rgba(12,18,30,.4)}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:19px}
  .card{position:relative;padding:19px 21px 15px;border-radius:15px;
        background:var(--panel);backdrop-filter:blur(13px);
        border:1px solid var(--line);
        box-shadow:0 12px 34px rgba(0,0,0,.46);
        animation:rise .5s cubic-bezier(.2,.8,.3,1) backwards;
        animation-delay:calc(var(--i) * 55ms);transition:transform .3s,box-shadow .3s,border-color .3s}
  @keyframes rise{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:none}}
  .card:hover{transform:translateY(-4px);border-color:rgba(49,224,255,.42);
              box-shadow:0 18px 44px rgba(0,0,0,.55),0 0 26px rgba(49,224,255,.14)}
  .card::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;
    background:linear-gradient(90deg,transparent,rgba(49,224,255,.55),transparent)}
  .s-rank{border-color:rgba(34,255,196,.44);box-shadow:0 12px 34px rgba(0,0,0,.46),0 0 30px rgba(34,255,196,.14)}
  .s-rank::before{background:linear-gradient(90deg,transparent,var(--mint),transparent)}
  .a-rank{border-color:rgba(49,224,255,.36)}

  .br{position:absolute;width:9px;height:9px;border:1px solid rgba(49,224,255,.42);opacity:.8}
  .tl{top:8px;left:8px;border-right:0;border-bottom:0}
  .tr{top:8px;right:8px;border-left:0;border-bottom:0}
  .bl{bottom:8px;left:8px;border-right:0;border-top:0}
  .br2{bottom:8px;right:8px;border-left:0;border-top:0}

  .c-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .code{font:600 10px/1 var(--mono);color:var(--cyan);letter-spacing:.22em;
        padding:4px 8px;border:1px solid rgba(49,224,255,.3);border-radius:5px;
        background:rgba(49,224,255,.07);display:inline-block}
  .rank{font:700 10px/1 var(--mono);letter-spacing:.1em;padding:4px 7px;border-radius:5px;
        margin-left:5px;display:inline-block;border:1px solid}
  .r-S{color:#05070d;background:var(--mint);border-color:var(--mint)}
  .r-A{color:var(--cyan);background:rgba(49,224,255,.14);border-color:rgba(49,224,255,.5)}
  .r-B{color:var(--blue);background:rgba(77,159,255,.12);border-color:rgba(77,159,255,.4)}
  .r-C{color:var(--amber);background:rgba(255,180,61,.1);border-color:rgba(255,180,61,.35)}
  .r-D{color:var(--dim);background:rgba(125,144,173,.08);border-color:var(--line)}
  .name{font-size:17px;font-weight:600;margin-top:9px;letter-spacing:.03em}
  .gauge{flex:none;margin:-2px -3px 0 0}
  .gauge-v{font:600 17px/1 var(--mono)}
  .gauge-u{font:500 7px/1 var(--mono);fill:var(--dim);letter-spacing:.16em}

  .price-row{display:flex;align-items:flex-end;gap:11px;margin:15px 0 4px;position:relative}
  .price{font:600 27px/1 var(--mono);letter-spacing:-.01em}
  .chg{font:600 12.5px/1 var(--mono);padding-bottom:4px}
  .chg .arrow{font-size:8px;margin-right:2px;vertical-align:1px}
  .spark{margin-left:auto;margin-bottom:-2px}

  .stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:15px;
         background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .cell{background:rgba(9,14,24,.72);padding:10px 12px;display:flex;
        justify-content:space-between;align-items:baseline;gap:8px}
  .k{font:500 9.5px/1.35 var(--mono);color:var(--dim);letter-spacing:.11em}
  .k i{font-style:normal;opacity:.6;font-size:8.5px;display:block;margin-top:2px}
  .v{font:600 14px/1 var(--mono)}

  .meta{display:flex;flex-wrap:wrap;gap:11px;margin-top:11px;
        font:500 9.5px/1 var(--mono);color:var(--dim);letter-spacing:.08em}
  .meta b{font-weight:600}
  .conf{margin-left:auto}

  .up{color:var(--mint)} .down{color:var(--rose)} .warn{color:var(--amber)}

  .c-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px;padding-top:12px;
          border-top:1px solid var(--line)}
  .chip{font:500 9.5px/1 var(--mono);letter-spacing:.1em;padding:5px 9px;border-radius:20px;border:1px solid;cursor:default}
  .cyan{color:var(--cyan);border-color:rgba(49,224,255,.34);background:rgba(49,224,255,.08)}
  .mint{color:var(--mint);border-color:rgba(34,255,196,.38);background:rgba(34,255,196,.1)}
  .amber{color:var(--amber);border-color:rgba(255,180,61,.36);background:rgba(255,180,61,.09)}
  .red{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.1)}
  .gray{color:var(--dim);border-color:var(--line);background:rgba(125,144,173,.08)}
  .flat{color:var(--dim);border-color:transparent;background:rgba(125,144,173,.07)}

  .stamp{margin-top:26px;font:400 10px/1.7 var(--mono);color:var(--dim);letter-spacing:.13em}
  @media(max-width:520px){.grid{grid-template-columns:1fr}.price{font-size:23px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">
      <div class="logo"><span>S7</span></div>
      <div>
        <h1>STEALTH <b>v7.1</b> AMBUSH</h1>
        <div class="sub">SBI EARNINGS CALENDAR × TDNET × KABUTAN</div>
      </div>
    </div>
    <div class="live"><span class="dot"></span>LIVE · ${watch.length + live.length} SYMBOLS LIVE / ${amb.results.length} SCREENED</div>
  </div>

  <div class="hud">
    ${readout('NIKKEI 225', macro.nikkei?.toLocaleString() ?? '--', ' 円')}
    ${readout('USD / JPY', fmt(macro.usdjpy), '', caution ? 'down' : '')}
    ${readout('AMBUSH NOW', String(now.length), ' 件', now.length ? 'up' : '')}
    ${readout('AMBUSH WATCH', String(later.length), ' 件')}
    ${readout('先行材料あり', String(amb.results.filter((r) => r.evidence).length), ' 件')}
    ${readout('UNIVERSE', `${amb.passed}/${amb.universe}`, ' 通過')}
    ${readout('LAST SYNC', new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }), ' JST')}
  </div>

  ${section('a', '🔥', 'AMBUSH NOW',
    `決算 T+${WINDOW.nowMin}〜T+${WINDOW.nowMax}日 · 取引所確定日 · 先行カタリストあり · SCORE 70以上 · 未織込条件クリア`,
    now.map((r, i) => card(r, i, { stale: !r.live })).join(''),
    `該当なし。ユニバース${amb.universe}銘柄中 Stage 1 通過は${amb.passed}銘柄でしたが、TDnetに先行カタリスト（好材料の開示・月次KPI）を持つ確定日銘柄はありませんでした。SECTION C に監視候補を出しています。`)}

  ${section('b', '📡', 'WATCHLIST',
    '常時追跡している登録銘柄。AMBUSHと同じ指標・同じ配点で毎回再計算しています。',
    watch.sort((x, y) => (y.score ?? -1) - (x.score ?? -1)).map((r, i) => card(r, i)).join(''),
    '取得できた銘柄がありません。')}

  ${section('c', '👀', 'AMBUSH WATCH',
    `Stage 1 通過 ${amb.passed}銘柄のうち NOW 条件を満たさなかったもの（決算 T+${WINDOW.nowMin}〜T+${WINDOW.watchMax}日）· スコア順 上位${AMBUSH_WATCH_MAX}件`,
    later.map((r, i) => card(r, i, { stale: !r.live })).join(''),
    'Stage 1 を通過した銘柄はありません。')}

  <div class="stamp">
    UPDATED ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ·
    決算日 SBI証券(${sbi.retrievedAt?.slice(0, 16).replace('T', ' ') ?? '--'}) ·
    開示 TDnet ${td.days}営業日/${td.total}件 ·
    株価 kabutan(20分ディレイ) · AUTO-REFRESH 60s<br>
    SCOREは取得できた項目のみで100点換算しています。DATA%が分母（情報量）です。
  </div>
</div>
</body>
</html>`;

  fs.writeFileSync(OUT_FILE, html);
  if (!NO_OPEN) exec(`open ${JSON.stringify(OUT_FILE)}`);
  console.log(
    `✅ 完了 / WATCHLIST ${watch.length}件 · AMBUSH NOW ${now.length}件 · WATCH ${later.length}件 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`
  );
}

// 異常終了でもロックを残さない（残っても30分で失効する）
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(1); });

main().catch((e) => {
  console.error(`❌ 異常終了: ${e.stack ?? e.message}`);
  releaseLock();
  process.exit(1);
});
