// ==================================================================
// STEALTH v7.2 "AMBUSH + SMART ENTRY"
//
//  v7.1（決算前の先行カタリストを探す AMBUSH）に、決算スケジュールを
//  無視して需給と乖離だけで機械的に仕込み時を探す SMART ENTRY を追加。
//  固定ウォッチリストは廃止 — 常時登録銘柄を眺めていても他の銘柄が
//  仕込み時なら意味がないため、全銘柄スキャンでその日ごとに入れ替わる。
//
//  さらに、全セクション共通の除外フィルター（低位株・薄商い・赤字/
//  債務超過は一切表示しない）と、初心者向けの結論表示（買い推奨/
//  様子見/見送りのステータスランプ・平易な日本語訳・過熱警告）を追加。
//
//  ■ データソース
//   決算予定日  : SBI証券 決算発表スケジュール（実体はIRISのJSONP・公開API）
//   適時開示    : TDnet（ルールベース判定。LLM APIは使わない）
//   株価/指標   : kabutan（kabukaページ1枚で価格・30日終値・出来高・市場区分）
//   信用残推移  : kabutan 週次信用残ページ（SMART ENTRYのみ）
//   業種騰落    : kabutan 東証【業種別】騰落ランキング（3リクエスト）
//   ※ Yahoo Finance は実測でIP単位の429、stooq はJS challenge のため不使用
//
//  ■ 1日のリクエスト数（実測）
//   SBI決算カレンダー   … 約32
//   TDnet 14営業日      … 約90
//   AMBUSH Stage 1      … 約250 / Stage 2 … 通過数 × 2
//   SMART ENTRY Stage 1 … 全銘柄（約3,400〜3,800）/ Stage 2 … 候補数 × 2
//   いずれも日次キャッシュ。場中の5分更新では 0件。
//   場中は AMBUSH・SMART ENTRY それぞれ上位のみを再取得する。
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
import { exec, execFileSync } from 'child_process';

import { fetchIntraday, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, volumeZScore, unpricedScore, goldenCross, volumeRatio,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal,
  marketLabel, overheatSignal, growthSurgeSignal, describeRsi, describeKairi,
  ambushVerdict, smartEntryVerdict, stage1, STAGE1,
} from './indicators.mjs';
import { loadEarningsCalendar } from './sbi.mjs';
import { loadHolidays, isMarketHoliday } from './holidays.mjs';
import { loadDisclosures, evaluate } from './tdnet.mjs';
import { runScreen, WINDOW } from './screener.mjs';
import { runSmartEntryScreen, smartEntryConviction } from './smart_entry.mjs';
import { loadSectorHistory, appendSectorHistory } from './sector_history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, 'index.html');

const FORCE = process.argv.includes('--force');
const NO_OPEN = process.argv.includes('--no-open');
const MARKET_HOURS_ONLY = process.argv.includes('--market-hours');
const DAILY_ONLY = process.argv.includes('--daily-only');

// 場中に価格を再取得する AMBUSH 銘柄数。
// 全通過銘柄を5分ごとに叩くとリクエストが膨らむので上位のみに絞る。
const AMBUSH_LIVE = 12;

// 場中に再判定する SMART ENTRY 銘柄数。AMBUSHと同じ理由で上位のみ。
const SMART_LIVE = 12;

// SECTION C に並べる監視候補の上限。Stage 1 通過は100銘柄を超えることが
// あるので、全部出すと画面が使い物にならない。
const AMBUSH_WATCH_MAX = 24;

// 祝日セットは main() で読み込んでここに入れる（launchdから5分ごとに
// 呼ばれるので、判定のたびに取得しないよう30日キャッシュを使う）
let HOLIDAYS = new Set();

function isMarketHours() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = jst.toISOString().slice(0, 10);
  if (isMarketHoliday(iso, HOLIDAYS)) return false; // 土日＋国民の祝日＋年末年始
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
//  ・記録されたPIDが生きた scraper.mjs なら降りる（経過時間は見ない）
//  ・プロセスが死んでいる／別物にPIDが再利用された／内容が壊れたロックは奪う
// ------------------------------------------------------------------
const LOCK_FILE = path.join(__dirname, '.scraper.lock');

// ロックの内容。素のPIDだけを書いていた頃の形式も読めるようにしておく。
function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    if (raw.startsWith('{')) return JSON.parse(raw);
    const pid = Number(raw);
    return Number.isFinite(pid) ? { pid, startedAt: null } : null;
  } catch {
    return null; // 読めない＝壊れている
  }
}

// 持ち主が「今も動いている scraper.mjs か」を確かめる。
//
//  ■ 経過時間で判断してはいけない
//  以前は「mtimeが30分より古ければ死んだ」と見なしていたが、これは
//  Macがスリープすると誤判定する。実測 2026-08-17 の07:00バッチは
//  Stage 1 の途中でスリープに入り、蓋を開けた20:26まで13時間中断された
//  （プロセスは生きたまま）。経過時間だけ見ると「古い＝死んだ」と判定され、
//  5分ごとの日中ジョブがロックを奪って同時実行になりうる。
//  スリープで止まったプロセスはハートビートも打てないので、
//  生存確認そのものを唯一の判断材料にする。
//
//  PIDは使い回されるため、生存＝即ロック有効とはしない。ps で中身を照合し、
//  無関係なプロセスがPIDを引き継いだ場合は奪えるようにする。
//
//  照合は「実行ファイルが node」かつ「引数に scraper.mjs」の両方を要求する。
//  command= の部分一致だけだと緩すぎて、scraper.mjs という文字列を
//  コマンドラインに含む無関係なプロセス（起動用のシェル、tail、grep など）を
//  持ち主と誤認する。実測: `node scraper.mjs` を含むシェルのPIDを書いたら
//  ロックが有効と判定されてしまった。
function lockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0); // シグナル0＝存在確認のみ。送信はしない
  } catch (e) {
    if (e.code !== 'EPERM') return false; // EPERM＝居るが他人のもの
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm=,args='], { encoding: 'utf-8' }).trim();
    if (!out) return false;
    const [comm, ...rest] = out.split(/\s+/);
    return /(^|\/)node(js)?$/.test(comm) && rest.join(' ').includes('scraper.mjs');
  } catch {
    return false; // ps に出てこない＝もう居ない
  }
}

let lockHolder = null; // 取れなかったときに持ち主を表示するため

function acquireLock() {
  // 'wx' は「存在しなければ作る、あれば失敗」をOSレベルで不可分に行う。
  // readFileSync→writeFileSync の順で書くと、同時起動した全プロセスが
  // 「ロック無し」を同時に観測して全員が通ってしまう（実測で3本とも通過）。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      const owner = readLock();
      if (owner && lockOwnerAlive(owner.pid)) {
        lockHolder = owner; // 生きている → 奪わない
        return false;
      }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 他が先に消した */ }
      // 1度だけ取り直しを試す
    }
  }
  return false;
}

function releaseLock() {
  const owner = readLock();
  if (owner?.pid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* 既に消えている */ }
  }
}

// ==================================================================
// ユーティリティ
// ==================================================================
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = (v, u = '') => (v === null || v === undefined ? '--' : `${v}${u}`);

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
      <text x="34" y="33" text-anchor="middle" class="gauge-v" fill="#c3d2ec">N/A</text>
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

// 買い推奨(青)/様子見(黄)/見送り(赤)のステータスランプ。
// 理由を1行添えて、初心者が数値を読まなくても結論が分かるようにする。
function verdictBlock(v) {
  if (!v) return '';
  return `<div class="verdict v-${v.level}">
        <span class="verdict-lamp"></span><span class="verdict-label">${esc(v.label)}</span>
        <span class="verdict-reason">${esc(v.reason ?? '')}</span>
      </div>`;
}

// 市場区分チップ（プライム/スタンダード/グロース）
function marketChip(market) {
  if (!market) return '';
  return `<span class="chip gray">${esc(marketLabel(market))}</span>`;
}

// 底打ち確認（＋α）— セリングクライマックス近似・ネットネット・配当下限・
// 踏み上げ狙い・業種出遅れの5シグナルを、該当したものだけチップで出す。
// 除外/減点には使わない（根拠を積み増す一言メモという位置づけ）。
function bottomChips(r) {
  const items = [r.climax, r.netNet, r.divFloor, r.squeeze, r.sectorLag, r.sectorRotation, r.marginOverhang, r.earningsWarning]
    .filter((s) => s && s.level);
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return items
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`)
    .join('');
}

// 「1日30分の銘柄調査ルーティン」の自分ルール（需給/下値/期待値/タイミング/
// 財務）をカード側で自動チェックする。財務（売上債権と売上高の伸び率比較）
// だけはIR Bank側に該当データが無く自動化できないため、常に「要手動確認」
// として区別する（できない判定を偽って自動化はしない）。
function buyRuleChecklist(r) {
  const rows = [];

  const supplyBad = r.marginOverhang?.level === 'bad';
  rows.push({
    label: '需給', ok: !supplyBad,
    note: supplyBad ? r.marginOverhang.note : (r.squeeze?.level === 'good' ? r.squeeze.note : '信用過多の兆候なし'),
  });

  const hasDownsideSupport = r.netNet?.level === 'good' || r.netNet?.level === 'warn';
  rows.push({
    label: '下値', ok: hasDownsideSupport ? true : null,
    note: hasDownsideSupport ? r.netNet.note : '解散価値等による下値の裏付けは確認できず',
  });

  let diffPct = null;
  if (Number.isFinite(r.estimateProfit) && Number.isFinite(r.consensusProfit) && r.consensusProfit !== 0) {
    diffPct = Math.round(((r.estimateProfit - r.consensusProfit) / Math.abs(r.consensusProfit)) * 1000) / 10;
  }
  rows.push({
    label: '期待値', ok: diffPct === null ? null : Math.abs(diffPct) <= 10,
    note: diffPct === null ? 'コンセンサスN/A' : `会社予想はコンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%`,
  });

  const timingBad = r.earningsWarning?.level === 'bad';
  const daysLeft = r.earningsDaysLeft ?? r.daysLeft ?? null;
  rows.push({
    label: 'タイミング', ok: !timingBad,
    note: timingBad ? r.earningsWarning.note : (daysLeft !== null ? `決算まであと${daysLeft}日` : '決算日情報なし'),
  });

  rows.push({ label: '財務', ok: null, manual: true, note: '売上債権と売上高の伸び率比較はIR Bank等で手動確認してください' });

  return rows;
}

function ruleChecklistBlock(r) {
  const rows = buyRuleChecklist(r);
  const scored = rows.filter((row) => !row.manual);
  const passed = scored.filter((row) => row.ok === true).length;
  const pills = rows.map((row) => {
    const mark = row.manual ? '？' : row.ok === true ? '✓' : row.ok === false ? '✗' : '？';
    const cls = row.manual ? 'gray' : row.ok === true ? 'mint' : row.ok === false ? 'red' : 'gray';
    return `<span class="rule ${cls}" title="${esc(row.note)}">${mark} ${esc(row.label)}</span>`;
  }).join('');
  return `<div class="rulebox">
        <div class="rulebox-head">自分ルール <span class="rulebox-score">${passed}/${scored.length}</span></div>
        <div class="rulebox-rows">${pills}</div>
      </div>`;
}

const kairiTone = (k) => (k === null ? '' : k < 0 ? 'up' : k > 5 ? 'down' : '');
const rsiTone = (v) => (v === null ? '' : v > 70 ? 'down' : v < 40 ? 'up' : '');
const volZTone = (v) => (v === null ? '' : v > 2 ? 'down' : v < 0 ? 'up' : '');
const progressTone = (p, basis) => {
  if (p === null || basis === null) return '';
  const excess = p - basis;
  return excess >= 5 ? 'up' : excess < -10 ? 'down' : '';
};

// 進捗率は「何に対する%か」で意味が変わる。基準だけでなく分母も出す。
// 例: 次回本決算＋対通期 →「基準75% · 通期」、次回中間＋対上期 →「基準50% · 上期」
function progressBasisLabel(r) {
  if (r.progressBasis === null || r.progressBasis === undefined) {
    return r.progress === null || r.progress === undefined ? '進捗N/A' : '基準N/A';
  }
  const denom = r.progressSource === 'sbi'
    ? '通期·SBI'
    : r.progressLabel?.includes('対上期') ? '上期·株探'
    : r.progressLabel?.includes('対通期') ? '通期·株探' : '株探';
  return `基準${r.progressBasis}% · ${denom}`;
}

// セクション内の表示順そのものを「順位」として見せるバッジ。
// 既存の並び順（AMBUSHはevidence優先→score順、SMART ENTRYはmatched数→
// 乖離が深い順）を変えずに、その順位を数字として可視化するだけ。
function rankBadge(i) {
  const n = i + 1;
  const cls = n === 1 ? 'r1' : n === 2 ? 'r2' : n === 3 ? 'r3' : '';
  return `<span class="rankpos ${cls}">${n}位</span>`;
}

function card(r, i, opts = {}) {
  const rankCls = r.rank === 'S' ? 's-rank' : r.rank === 'A' ? 'a-rank' : '';
  const verdict = ambushVerdict(r);
  const overheat = overheatSignal(r.kairi);
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  // Stage1（乖離≤+5% / RSI≤60 / 出来高Z≤0.5）は日次スキャン時点の足切り。
  // 場中は上位銘柄の価格だけ再取得して表示するため（Stage1の再判定はしない）、
  // 値動きが進んでスキャン時点の「未織込」基準を後から超えることがある。
  // 黙って通し続けると「期待値が織り込まれた株」を仕込み候補のまま見せて
  // しまうので、超えたら分かるようにバッジで警告する（除外はしない＝
  // 一覧から消すと「何が通過していたか」が追えなくなるため）。
  const pricedIn = r.kairi !== null && r.rsi !== null && r.volZ !== null
    && !stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass;
  const catalystChips = (r.catalysts ?? []).slice(0, 3)
    .map((c) => `<span class="chip mint" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');
  const warnChips = (r.warnings ?? []).slice(0, 2)
    .map((c) => `<span class="chip red" title="${esc(c.date)} ${esc(c.title)}">${esc(c.label)}</span>`).join('');

  return `
      <article class="card ${rankCls}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${scoreGauge(r.score)}
        </header>
        ${verdictBlock(verdict)}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="stats">
          <div class="cell"><span class="k">乖離率<i>未織込 ${fmt(unpricedScore(r.kairi), '/10')} · ${describeKairi(r.kairi)}</i></span><span class="v ${kairiTone(r.kairi)}">${fmt(r.kairi, '%')}</span></div>
          <div class="cell"><span class="k">RSI<i>14日 · ${describeRsi(r.rsi)}</i></span><span class="v ${rsiTone(r.rsi)}">${fmt(r.rsi)}</span></div>
          <div class="cell"><span class="k">出来高Z<i>20日</i></span><span class="v ${volZTone(r.volZ)}">${fmt(r.volZ)}</span></div>
          <div class="cell"><span class="k">進捗<i>${progressBasisLabel(r)}</i></span><span class="v ${progressTone(r.progress, r.progressBasis)}">${fmt(r.progress, '%')}</span></div>
        </div>

        <div class="meta">
          <span>${esc(r.sectorName ?? '業種N/A')} ${r.sectorChangePct !== null && r.sectorChangePct !== undefined ? `<b class="${r.sectorChangePct >= 0 ? 'up' : 'down'}">${r.sectorChangePct > 0 ? '+' : ''}${r.sectorChangePct}%</b>` : ''}</span>
          <span>信用 ${fmt(r.loanRatio, '倍')}</span>
          <span>PER ${fmt(r.per, '倍')}</span>
          <span class="conf" title="スコア算出に使えた情報量。100%＝月次/PR/進捗/セクター/テクニカルが全て取得できた状態${r.confidenceRaw && r.confidenceRaw !== r.confidence ? `。方向不明の開示があるため ${r.confidenceRaw}% から ${r.confidenceRaw - r.confidence}pt 控除` : ''}">DATA ${r.confidence ?? 0}%</span>
        </div>
        ${ruleChecklistBlock(r)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${bottomChips(r)}
          ${catalystChips}${warnChips}
          ${earningsBadge(r)}
          ${overheat.level === 'bad' ? `<span class="chip red" title="${esc(overheat.note)}">${esc(overheat.label)}</span>` : ''}
          ${growthSurge.level === 'bad' ? `<span class="chip red" title="${esc(growthSurge.note)}">${esc(growthSurge.label)}</span>` : ''}
          ${overheat.level !== 'bad' && pricedIn ? `<span class="chip amber" title="スキャン時点は未織込条件（乖離≤+${STAGE1.maxKairi}%・RSI≤${STAGE1.maxRsi}）を満たしていましたが、その後の値動きで乖離${r.kairi}%・RSI${r.rsi}まで進み、基準を超えました">織込み進行</span>` : ''}
          ${r.ambiguous ? `<span class="chip gray" title="「業績予想の修正」等、題名から上方/下方が判別できない開示">方向不明 ${r.ambiguous}</span>` : ''}
          ${r.hasMonthly ? '<span class="chip flat" title="月次開示あり。前年比の数値はPDF内のため未取得">月次あり</span>' : ''}
          ${r.evidence === false ? '<span class="chip gray" title="TDnetに好材料の開示も月次KPIも無いため、先行カタリストの根拠がありません。スコアが高くてもS/Aランクは付けず、AMBUSH NOWにも入れていません">先行材料なし</span>' : ''}
          ${opts.stale ? '<span class="chip gray">日次値</span>' : ''}
        </footer>
      </article>`;
}

// ------------------------------------------------------------------
// SMART ENTRY専用: 仕込みパターンカード（AMBUSHのスコア/ランクは使わない）
// ------------------------------------------------------------------
const SIG_EMOJI = { good: '🟢', partial: '🟡', warn: '🟡', bad: '🔴', null: '⚪' };
const SIG_CLASS = { good: 'mint', partial: 'amber', warn: 'amber', bad: 'red', null: 'gray' };

function signalRow(title, sig) {
  const emoji = SIG_EMOJI[sig.level ?? 'null'];
  const cls = SIG_CLASS[sig.level ?? 'null'];
  return `<div class="sig">
        <div class="sig-head"><span class="sig-e">${emoji}</span><span class="sig-t">${esc(title)}</span><span class="chip ${cls}">${esc(sig.label)}</span></div>
        <div class="sig-n">${esc(sig.note)}</div>
      </div>`;
}

function smartEntryCard(r, i) {
  const overheat = overheatSignal(r.kairi);
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  const verdict = smartEntryVerdict(r, overheat, growthSurge);
  // 選定時点はいずれかのパターンに該当していたが、場中の値動きで
  // 3条件どれも「該当」でなくなった状態。初心者にも分かるよう
  // 「なぜもう買い時ではないのか」を一言で示す。
  const patternExpired = ![r.sig1, r.sig2, r.sig3].some((s) => s?.level === 'good');

  return `
      <article class="card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
        </header>
        ${verdictBlock(verdict)}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="signals">
          ${signalRow('① リバウンド狙い（逆張り）', r.sig1)}
          ${signalRow('② トレンド転換の初動（順張り）', r.sig2)}
          ${signalRow('③ しこり解消・出遅れ株', r.sig3)}
        </div>
        ${ruleChecklistBlock(r)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${bottomChips(r)}
          ${overheat.level === 'bad' ? `<span class="chip red" title="${esc(overheat.note)}">${esc(overheat.label)}</span>` : ''}
          ${growthSurge.level === 'bad' ? `<span class="chip red" title="${esc(growthSurge.note)}">${esc(growthSurge.label)}</span>` : ''}
          ${patternExpired ? '<span class="chip red" title="選んだ時点では3つの仕込みパターンのいずれかに当てはまっていましたが、その後の値動きでどれにも当てはまらなくなりました。今から新規に買う根拠にはなりません">条件外れ</span>' : ''}
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

  // 祝日判定は場外スキップの前に必要。30日キャッシュなので通常は0リクエスト。
  const hol = await loadHolidays({ force: FORCE });
  HOLIDAYS = hol.dates;
  if (hol.source === 'unavailable') {
    console.error('  ⚠️ 祝日データが無いため、土日判定のみで動作します');
  } else if (hol.coverageEnd && hol.coverageEnd < todayJST()) {
    console.error(`  ⚠️ 祝日データが ${hol.coverageEnd} までしかありません。内閣府CSVの更新を確認してください`);
  }

  if (MARKET_HOURS_ONLY && !isMarketHours()) {
    console.log(`⏸  場外のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
    return;
  }
  // 場外判定の「後」にロックを取る。場外スキップは一瞬なので競合しない。
  if (!acquireLock()) {
    const since = lockHolder?.startedAt
      ? new Date(lockHolder.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : null;
    const held = lockHolder ? ` — PID ${lockHolder.pid}${since ? ` が ${since} から実行中` : ''}` : '';
    console.log(`⏸  別のインスタンスが実行中のためスキップ (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})${held}`);
    return;
  }
  console.log('🚀 STEALTH v7.2 "AMBUSH + SMART ENTRY" 起動');
  const today = todayJST();

  // ---- 日次パート（キャッシュ）------------------------------------
  const sbi = await loadEarningsCalendar({ today, horizonDays: 60, force: FORCE });
  const td = await loadDisclosures({ today, days: 14, force: FORCE });
  // 出遅れ修正（セクターローテーション）判定用。今日の値を混ぜると
  // 「業種は既に反発済み」の判定に場中の未確定値が入ってしまうため、
  // 過去日までの履歴を渡してから、今日ぶんは実行後に積み増す。
  const sectorHistory = loadSectorHistory();
  const amb = await runScreen({ today, sbiStocks: sbi.stocks, disclosures: td.byCode, sectorHistory, force: FORCE });
  appendSectorHistory(today, amb.sectors ?? {});
  const smart = await runSmartEntryScreen({ today, tdNames: td.names ?? {}, sbiStocks: sbi.stocks, sectors: amb.sectors ?? {}, sectorHistory, force: FORCE });

  if (DAILY_ONLY) {
    console.log(`✅ 日次パート完了 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    return;
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
  // NOW条件（確定日・SCORE70以上）は満たさなかったが、TDnetに好材料の開示や
  // 月次KPIなど「先行カタリストの根拠」があるものだけを仕込み候補として分離する。
  // 根拠が無い銘柄はスコアが高くても、進捗率/セクター/テクニカルだけで
  // 積み上がった数字なので参考程度（section()のグループ分けで可視化）。
  const laterEvidence = later.filter((r) => r.evidence);
  const laterNoEvidence = later.filter((r) => !r.evidence);
  const live = [...now, ...later].slice(0, AMBUSH_LIVE);

  let macro = { nikkei: null, usdjpy: null };
  if (live.length) {
    console.log(`🔄 AMBUSH上位${live.length}銘柄の価格を更新`);
    for (const r of live) {
      try {
        const iv = await fetchIntraday(r.code);
        if (iv.macro.nikkei) macro = iv.macro;
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

  // SMART ENTRYと同じ理由（場中の値動きで結論が「買い推奨」から落ちた
  // 銘柄が、朝のバッチ時点の並び順のまま上位に居座るのを防ぐ）で、
  // ステータスランプを最優先の基準に並べ直す。
  const AMBUSH_VERDICT_ORDER = { buy: 0, hold: 1, avoid: 2 };
  const verdictRank = (r) => AMBUSH_VERDICT_ORDER[ambushVerdict(r).level] ?? 1;
  const byVerdict = (a, b) => verdictRank(a) - verdictRank(b) || (b.score ?? -1) - (a.score ?? -1);
  now.sort(byVerdict);
  laterEvidence.sort(byVerdict);
  laterNoEvidence.sort(byVerdict);

  // ---- SECTION B: SMART ENTRY（上位のみ場中も再判定）----------------
  // 信用残（週次）と決算は日次スキャン時点のまま据え置き、テクニカルだけ
  // 再取得して3パターンの該当状況を再判定する。
  const smartLive = smart.results.slice(0, SMART_LIVE);
  if (smartLive.length) {
    console.log(`🔄 SMART ENTRY上位${smartLive.length}銘柄を再判定`);
    for (const r of smartLive) {
      try {
        const iv = await fetchIntraday(r.code);
        if (!macro.nikkei && iv.macro.nikkei) macro = iv.macro;
        r.price = iv.price;
        r.changePct = iv.changePct;
        r.closes = iv.closes.slice(-20);
        r.kairi = kairi(iv.price, iv.closes);
        r.rsi = rsi(iv.closes);
        r.cross = goldenCross(iv.closes);
        r.volRatio = volumeRatio(iv.volumes);
        r.sig1 = reboundPatternSignal({ kairi: r.kairi, rsi: r.rsi, creditTrendPct: r.creditTrendPct });
        r.sig2 = trendReversalPatternSignal({ cross: r.cross, volRatio: r.volRatio, loanRatio: r.loanRatio });
        r.sig3 = laggingPatternSignal({
          creditLevelPct: r.creditLevelPct, estimateProfit: r.estimateProfit, consensusProfit: r.consensusProfit, kairi: r.kairi,
        });
        r.matched = [r.sig1.level === 'good', r.sig2.level === 'good', r.sig3.level === 'good'].filter(Boolean).length;
        r.live = true;
      } catch (e) {
        console.error(`  ⚠️ ${r.code} 再判定失敗: ${e.message}`);
      }
      await sleep(REQ_GAP);
    }
  }

  // 場中の再判定で「買い推奨」→「様子見/見送り」に変わった銘柄が、
  // 朝のバッチ時点の並び順のまま上位に居座らないよう、結論（ステータス
  // ランプ）を最優先の基準にして並べ直す。順位バッジは表示直前の
  // この配列の並びをそのまま数字にしているため、ここで直す必要がある。
  const VERDICT_ORDER = { buy: 0, hold: 1, avoid: 2 };
  smart.results.sort((a, b) => {
    const va = smartEntryVerdict(a, overheatSignal(a.kairi), growthSurgeSignal(a.market, a.closes));
    const vb = smartEntryVerdict(b, overheatSignal(b.kairi), growthSurgeSignal(b.market, b.closes));
    return (VERDICT_ORDER[va.level] - VERDICT_ORDER[vb.level])
      || (smartEntryConviction(b) - smartEntryConviction(a))
      || ((a.kairi ?? 999) - (b.kairi ?? 999));
  });

  if (!smart.results.length && !amb.results.length) {
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
<!-- これが無いとモバイルSafariは幅980pxで描画して全体を縮小するため、
     @media(max-width:520px) が発火せず文字が読めない。スマホ表示の必須項目。
     user-scalable は制限しない（拡大したい場面があるため）。 -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<!-- ホーム画面に追加したときに全画面で開く -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AMBUSH">
<title>STEALTH v7.2 AMBUSH + SMART ENTRY</title>
<style>
  :root{
    --bg:#05070d; --panel:rgba(17,24,38,.62); --line:rgba(90,130,190,.20);
    --txt:#ffffff; --dim:#c3d2ec; --cyan:#31e0ff; --mint:#22ffc4;
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
  .logo span{font:700 17px/1 var(--mono);color:var(--cyan)}
  h1{font-size:23px;font-weight:600;letter-spacing:.16em}
  h1 b{color:var(--cyan);font-weight:600}
  .sub{font:400 12px/1 var(--mono);color:var(--dim);letter-spacing:.24em;margin-top:6px}
  .live{display:flex;align-items:center;gap:7px;font:500 12px/1 var(--mono);
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
  .ro-k{display:block;font:500 11px/1 var(--mono);color:var(--dim);letter-spacing:.2em;margin-bottom:7px}
  .ro-v{font:600 23px/1 var(--mono);color:var(--txt);letter-spacing:.01em}
  .ro-v i{font-style:normal;font-size:12.5px;color:var(--dim);margin-left:3px}

  /* ── セクション ── */
  .sec{margin-bottom:34px}
  .sec-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:15px;
            padding-bottom:11px;border-bottom:1px solid var(--line)}
  .sec-head h2{font-size:17px;font-weight:600;letter-spacing:.13em;display:flex;align-items:center;gap:9px}
  .ico{font-size:17px}
  .sec-head p{font:400 12px/1.6 var(--mono);color:var(--dim);letter-spacing:.06em}
  .empty{padding:26px 22px;border:1px dashed var(--line);border-radius:12px;
         font:400 13px/1.8 var(--mono);color:var(--dim);background:rgba(12,18,30,.4)}

  /* ── AMBUSH WATCHのサブグループ見出し（仕込み候補 / 参考） ── */
  .subhead{font:700 11.5px/1 var(--mono);letter-spacing:.1em;margin:22px 0 13px;
           padding-bottom:8px;border-bottom:1px dashed var(--line)}
  .sec .grid + .subhead{margin-top:26px}
  .subhead.sub-good{color:var(--mint)}
  .subhead.sub-ref{color:var(--dim)}

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
  .code{font:600 11.5px/1 var(--mono);color:var(--cyan);letter-spacing:.22em;
        padding:4px 8px;border:1px solid rgba(49,224,255,.3);border-radius:5px;
        background:rgba(49,224,255,.07);display:inline-block}
  .rank{font:700 11.5px/1 var(--mono);letter-spacing:.1em;padding:4px 7px;border-radius:5px;
        margin-left:5px;display:inline-block;border:1px solid}
  .r-S{color:#05070d;background:var(--mint);border-color:var(--mint)}
  .r-A{color:var(--cyan);background:rgba(49,224,255,.14);border-color:rgba(49,224,255,.5)}
  .r-B{color:var(--blue);background:rgba(77,159,255,.12);border-color:rgba(77,159,255,.4)}
  .r-C{color:var(--amber);background:rgba(255,180,61,.1);border-color:rgba(255,180,61,.35)}
  .r-D{color:var(--dim);background:rgba(125,144,173,.08);border-color:var(--line)}

  /* ── セクション内の順位バッジ ── */
  .rankpos{font:700 11px/1 var(--mono);letter-spacing:.06em;padding:4px 8px;border-radius:5px;
           display:inline-block;border:1px solid var(--line);color:var(--dim);margin-right:2px}
  .rankpos.r1{color:#05070d;background:var(--mint);border-color:var(--mint)}
  .rankpos.r2{color:var(--cyan);background:rgba(49,224,255,.14);border-color:rgba(49,224,255,.5)}
  .rankpos.r3{color:var(--amber);background:rgba(255,180,61,.12);border-color:rgba(255,180,61,.4)}
  .name{font-size:19.5px;font-weight:600;margin-top:9px;letter-spacing:.03em}
  .gauge{flex:none;margin:-2px -3px 0 0}
  .gauge-v{font:600 19.5px/1 var(--mono)}
  .gauge-u{font:500 8px/1 var(--mono);fill:var(--dim);letter-spacing:.16em}

  /* ── ステータスランプ（買い推奨/様子見/見送り） ── */
  .verdict{display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px;
           margin-top:12px;padding:8px 12px;border-radius:9px;border:1px solid}
  .verdict-lamp{width:9px;height:9px;border-radius:50%;flex:none}
  .verdict-label{font:700 14px/1 var(--mono);letter-spacing:.06em}
  .verdict-reason{flex-basis:100%;font:500 11.5px/1.4 var(--mono);color:var(--dim);letter-spacing:.02em}
  .v-buy{border-color:rgba(49,224,255,.4);background:rgba(49,224,255,.08)}
  .v-buy .verdict-lamp{background:var(--cyan);box-shadow:0 0 8px var(--cyan)}
  .v-buy .verdict-label{color:var(--cyan)}
  .v-hold{border-color:rgba(255,180,61,.4);background:rgba(255,180,61,.08)}
  .v-hold .verdict-lamp{background:var(--amber);box-shadow:0 0 8px var(--amber)}
  .v-hold .verdict-label{color:var(--amber)}
  .v-avoid{border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.08)}
  .v-avoid .verdict-lamp{background:var(--rose);box-shadow:0 0 8px var(--rose)}
  .v-avoid .verdict-label{color:var(--rose)}

  .price-row{display:flex;align-items:flex-end;gap:11px;margin:15px 0 4px;position:relative}
  .price{font:600 31px/1 var(--mono);letter-spacing:-.01em}
  .chg{font:600 14.5px/1 var(--mono);padding-bottom:4px}
  .chg .arrow{font-size:9px;margin-right:2px;vertical-align:1px}
  .spark{margin-left:auto;margin-bottom:-2px}

  .stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:15px;
         background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .cell{background:rgba(9,14,24,.72);padding:10px 12px;display:flex;
        justify-content:space-between;align-items:baseline;gap:8px}
  .k{font:500 11px/1.35 var(--mono);color:var(--dim);letter-spacing:.11em}
  .k i{font-style:normal;opacity:.6;font-size:10px;display:block;margin-top:2px}
  .v{font:600 16px/1 var(--mono)}

  .signals{display:flex;flex-direction:column;gap:8px;margin-top:15px}
  .sig{background:rgba(9,14,24,.72);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  .sig-head{display:flex;align-items:center;gap:7px}
  .sig-e{font-size:15px;line-height:1}
  .sig-t{font:500 11px/1.2 var(--mono);color:var(--dim);letter-spacing:.08em;flex:1}
  .sig-n{margin-top:5px;font:500 11px/1.4 var(--mono);color:var(--dim);letter-spacing:.02em}

  /* ── 自分ルール（1日30分ルーティンの自動チェック） ── */
  .rulebox{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
           background:rgba(9,14,24,.72)}
  .rulebox-head{font:700 10px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:7px}
  .rulebox-score{color:var(--txt);font-weight:700}
  .rulebox-rows{display:flex;flex-wrap:wrap;gap:6px}
  .rule{font:600 10px/1 var(--mono);letter-spacing:.04em;padding:4px 8px;border-radius:14px;
        border:1px solid;cursor:default}
  .rule.mint{color:var(--mint);border-color:rgba(34,255,196,.38);background:rgba(34,255,196,.1)}
  .rule.red{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.1)}
  .rule.gray{color:var(--dim);border-color:var(--line);background:rgba(125,144,173,.08)}

  .meta{display:flex;flex-wrap:wrap;gap:11px;margin-top:11px;
        font:500 11px/1 var(--mono);color:var(--dim);letter-spacing:.08em}
  .meta b{font-weight:600}
  .conf{margin-left:auto}

  .up{color:var(--mint)} .down{color:var(--rose)} .warn{color:var(--amber)}

  .c-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px;padding-top:12px;
          border-top:1px solid var(--line)}
  .chip{font:500 11px/1 var(--mono);letter-spacing:.1em;padding:5px 9px;border-radius:20px;border:1px solid;cursor:default}
  .cyan{color:var(--cyan);border-color:rgba(49,224,255,.34);background:rgba(49,224,255,.08)}
  .mint{color:var(--mint);border-color:rgba(34,255,196,.38);background:rgba(34,255,196,.1)}
  .amber{color:var(--amber);border-color:rgba(255,180,61,.36);background:rgba(255,180,61,.09)}
  .red{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.1)}
  .gray{color:var(--dim);border-color:var(--line);background:rgba(125,144,173,.08)}
  .flat{color:var(--dim);border-color:transparent;background:rgba(125,144,173,.07)}

  .stamp{margin-top:26px;font:400 11.5px/1.7 var(--mono);color:var(--dim);letter-spacing:.13em}
  /* ── スマホ ────────────────────────────────────────────────
     viewportメタタグを入れたのでここが初めて実際に効くようになった。
     iPhoneの幅390pxを基準に、横スクロールが出ないことを条件に詰める。 */
  @media(max-width:520px){
    /* 左右パディング28px×2は390px幅では大きすぎる。カードの実効幅を稼ぐ */
    body{padding:16px 13px 34px}
    body::after{background-size:32px 32px}
    .top{gap:12px;margin-bottom:16px}
    .grid{grid-template-columns:1fr;gap:13px}
    .card{padding:16px 15px 13px}
    .price{font-size:26.5px}
    /* HUDは min-width:150px + padding40px = 190px で2列に収まらない。
       flexの2列に固定して、右列の縦罫線を消す */
    .ro{min-width:0;flex:1 1 calc(50% - 1px);padding:11px 13px}
    .ro:nth-child(2n){border-right:none}
    /* スパークラインは150px固定だと株価と衝突する */
    .spark{width:96px;height:30px}
    .sec-head{margin-bottom:12px}
    .name{font-size:18.5px}
    .chip{font-size:10.5px;padding:5px 8px}
  }
  /* 特に狭い端末（iPhone SE = 375px, mini = 360px）では2列の数値も窮屈 */
  @media(max-width:380px){
    .stats{grid-template-columns:1fr}
    .ro{flex:1 1 100%;border-right:none}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">
      <div class="logo"><span>S7</span></div>
      <div>
        <h1>STEALTH <b>v7.2</b> AMBUSH + SMART ENTRY</h1>
        <div class="sub">SBI EARNINGS CALENDAR × TDNET × KABUTAN</div>
      </div>
    </div>
    <div class="live"><span class="dot"></span>LIVE · ${live.length + smartLive.length} SYMBOLS LIVE / ${amb.results.length + smart.results.length} SCREENED</div>
  </div>

  <div class="hud">
    ${readout('NIKKEI 225', macro.nikkei?.toLocaleString() ?? '--', ' 円')}
    ${readout('USD / JPY', fmt(macro.usdjpy), '', caution ? 'down' : '')}
    ${readout('AMBUSH NOW', String(now.length), ' 件', now.length ? 'up' : '')}
    ${readout('AMBUSH WATCH', String(later.length), ' 件')}
    ${readout('SMART ENTRY', `${smart.matched}/${smart.universe}`, ' 該当', smart.matched ? 'up' : '')}
    ${readout('先行材料あり', String(amb.results.filter((r) => r.evidence).length), ' 件')}
    ${readout('UNIVERSE', `${amb.passed}/${amb.universe}`, ' 通過')}
    ${readout('LAST SYNC', new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }), ' JST')}
  </div>

  ${section('a', '🔥', 'AMBUSH NOW',
    `決算 T+${WINDOW.nowMin}〜T+${WINDOW.nowMax}日 · 取引所確定日 · 先行カタリストあり · SCORE 70以上 · 未織込条件クリア`,
    now.map((r, i) => card(r, i, { stale: !r.live })).join(''),
    `該当なし。ユニバース${amb.universe}銘柄中 Stage 1 通過は${amb.passed}銘柄でしたが、TDnetに先行カタリスト（好材料の開示・月次KPI）を持つ確定日銘柄はありませんでした。SECTION C に監視候補を出しています。`)}

  ${section('b', '🎯', 'SMART ENTRY',
    '決算スケジュールは見ず、需給と乖離だけで機械的にスクリーニングした「仕込み時」の銘柄。固定の登録銘柄ではなく、条件に合う銘柄がその日ごとに入れ替わります。低位株・薄商い・赤字/債務超過は全セクション共通で除外済み。底打ちを裏付ける根拠（出来高急増・解散価値割れ・配当下限・空売り膨張・業種の出遅れ）が見つかった銘柄にはチップを表示し、結論（買い推奨→様子見→見送り）が高い順に並べています。',
    smart.results.map((r, i) => smartEntryCard(r, i)).join(''),
    `該当なし。ユニバース${smart.universe}銘柄をスキャンしましたが、3つの仕込みパターンのいずれにも合致する銘柄がありませんでした。`)}

  <section class="sec" id="c">
    <div class="sec-head">
      <h2><span class="ico">👀</span>AMBUSH WATCH</h2>
      <p>Stage 1 通過 ${amb.passed}銘柄のうち NOW 条件を満たさなかったもの（決算 T+${WINDOW.nowMin}〜T+${WINDOW.watchMax}日）· 上位${AMBUSH_WATCH_MAX}件 · 結論（買い推奨→様子見→見送り）順に並べ、先行カタリストの有無で「仕込み候補」「参考」に分けています</p>
    </div>
    ${!later.length ? `<div class="empty">Stage 1 を通過した銘柄はありません。</div>` : `
    ${laterEvidence.length ? `
    <div class="subhead sub-good">🟢 仕込み候補 — 先行カタリストの根拠あり（${laterEvidence.length}件）</div>
    <div class="grid">${laterEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    ${laterNoEvidence.length ? `
    <div class="subhead sub-ref">⚪ 参考 — 先行材料なし・スコアは目安程度（${laterNoEvidence.length}件）</div>
    <div class="grid">${laterNoEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    `}
  </section>

  <div class="stamp">
    UPDATED ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ·
    決算日 SBI証券(${sbi.retrievedAt?.slice(0, 16).replace('T', ' ') ?? '--'}) ·
    開示 TDnet ${td.days}営業日/${td.total}件 ·
    株価 kabutan(20分ディレイ) · AUTO-REFRESH 60s<br>
    SCOREは取得できた項目のみで100点換算しています。DATA%が分母（情報量）です。
    低位株(300円未満)・薄商い(5日平均売買代金1億円未満)・赤字/債務超過の銘柄は全セクションで非表示にしています。
  </div>
</div>
<script>
// 自動更新。meta refresh だとスマホで読んでいる途中に毎分先頭へ飛ばされるので、
// スクロール位置を保存してから再読込し、復帰後に戻す。
// 裏に回っているタブは更新しない（無駄なリクエストとバッテリー消費を避ける）。
(function () {
  var KEY = 'ambush.scrollY';
  function save() { try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) { } }
  try {
    var y = sessionStorage.getItem(KEY);
    if (y) window.scrollTo(0, parseInt(y, 10) || 0);
  } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
  addEventListener('pagehide', save);
  addEventListener('beforeunload', save);
  setInterval(function () {
    if (!document.hidden) { save(); location.reload(); }
  }, 60000);
})();
</script>
</body>
</html>`;

  fs.writeFileSync(OUT_FILE, html);
  publishToICloud(html);
  if (!NO_OPEN) exec(`open ${JSON.stringify(OUT_FILE)}`);
  console.log(
    `✅ 完了 / SMART ENTRY ${smart.results.length}件 · AMBUSH NOW ${now.length}件 · WATCH ${later.length}件 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`
  );
}

// ------------------------------------------------------------------
// スマホ向けの配信 — iCloud Drive にコピーする
//
//  Macのローカルファイルはスマホから開けない。LAN配信(python -m http.server)
//  でも見られるが、Macが起きていて同じWi-Fiに居ることが条件になる。
//  実測でこのMacは日中よくスリープする（2026-08-17 は07:00バッチが
//  20:26まで中断された）ので、外出先でも見られる iCloud 経由を既定にする。
//
//  index.html は画像もCSSも全て内蔵した1枚なので、ファイルを置くだけで動く。
//  iPhone側: ファイルアプリ → iCloud Drive → AMBUSH → AMBUSH.html
//
//  iCloudを使っていないMacでは黙ってスキップする（失敗させない）。
// ------------------------------------------------------------------
const ICLOUD_DIR = path.join(
  process.env.HOME ?? '',
  'Library/Mobile Documents/com~apple~CloudDocs/AMBUSH'
);

function publishToICloud(html) {
  const root = path.dirname(ICLOUD_DIR);
  if (!fs.existsSync(root)) return; // iCloud Drive 未使用
  try {
    fs.mkdirSync(ICLOUD_DIR, { recursive: true });
    // 同期中の半端なファイルを見せないよう、別名で書いてから置き換える
    const dest = path.join(ICLOUD_DIR, 'AMBUSH.html');
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, dest);
    console.log(`📱 iCloudへ配信: ${dest}`);
  } catch (e) {
    console.error(`  ⚠️ iCloudへの配信失敗: ${e.message}`);
  }
}

// 異常終了でもロックを残さない（残った場合も次回に生存確認で回収される）
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(1); });

main().catch((e) => {
  console.error(`❌ 異常終了: ${e.stack ?? e.message}`);
  releaseLock();
  process.exit(1);
});
