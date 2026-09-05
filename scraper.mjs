// ==================================================================
// STEALTH v7.3 "AMBUSH + SMART ENTRY"
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
  ambushVerdict, smartEntryVerdict, stage1, STAGE1, CHIP_SIGNAL_FIELDS, VALUATION_CHIP_FIELDS, hasConsensusProfit,
  OVERHEAT_KAIRI, hasPrecursor, PRECURSOR_GOOD_FIELDS, PRECURSOR_CAUTION_FIELDS, VERDICT_SEVERITY,
  buildScoreParts, buyScore, buyScoreRiskPenalty, expectationScore, earningsSurpriseScore, confidenceTier, effectiveScore, badChipSignals,
} from './indicators.mjs';
import { loadEarningsCalendar } from './sbi.mjs';
import { loadHolidays, isMarketHoliday } from './holidays.mjs';
import { loadDisclosures, evaluate } from './tdnet.mjs';
import { runScreen, WINDOW, ambushConviction, AMBUSH_BONUS_FIELDS, AMBUSH_PENALTY_FIELDS } from './screener.mjs';
import { runSmartEntryScreen, smartEntryConviction } from './smart_entry.mjs';
import { runUsScreen, US_WINDOW } from './us_screener.mjs';
import { runUsTenbaggerScreen } from './us_tenbagger.mjs';
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

// ユーザー要望「順位は10位までにして」。rankBadge（N位表示）を使う
// ランキング形式の全セクション（AMBUSH NOW/WATCH・SMART ENTRY・
// カタリスト予兆・米国株AMBUSH・テンバガー候補）で表示件数の上限を
// 統一する。AMBUSH_LIVE/SMART_LIVE（場中の価格再取得対象数）とは別物
// （こちらは表示のみを絞る。価格再取得ロジックには影響させない）。
const RANK_TOP_N = 10;

// SECTION C に並べる監視候補の上限。Stage 1 通過は100銘柄を超えることが
// あるので、全部出すと画面が使い物にならない。
const AMBUSH_WATCH_MAX = RANK_TOP_N;

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
  // ユーザー指摘: メインのSCORE（技術・財務の総合力）とカード下部の
  // 「妙味スコア」（今から買うタイミング/織り込み度）が別軸なのに説明が
  // 無く、どちらを信じればいいか分からなかった（実測: APLDでSCORE70・
  // 妙味スコア44.5と乖離）。SVGタイトル（ホバー説明）で軸の違いを明記する。
  return `<svg class="gauge" width="68" height="68" viewBox="0 0 68 68">
      <title>SCORE＝技術・財務の総合力（素点）。実際の順位はBUY SCORE（期待リターン・未織り込み度・サプライズ期待・タイミング・企業クオリティを合成した値にCONFIDENCEで補正したEffective Score）で決まります。カード下部の「妙味スコア」はBUY SCOREの「未織り込み度」要素と同じ値です</title>
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

// 強い買い候補(緑)/買い候補(青)/様子見(黄)/織り込み警戒(橙)/見送り(赤)の
// ステータスランプ（v7.3で3段階から5段階に拡張）。
// 理由を1行添えて、初心者が数値を読まなくても結論が分かるようにする。
function verdictBlock(v) {
  if (!v) return '';
  return `<div class="verdict v-${v.level}">
        <span class="verdict-lamp"></span><span class="verdict-label">${esc(v.label)}</span>
        <span class="verdict-reason">${esc(v.reason ?? '')}</span>
      </div>`;
}

// v7.3改修（ユーザー指示書 項目1/2/7/15）: BUY/EXPECTATION/SURPRISEスコアと
// CONFIDENCEの表示。上部のSCOREガウジは「素点」のまま残し、実際の順位に
// 使うEffective Score（=BUY SCORE×CONFIDENCE係数）の内訳をここで明示する。
//
// 実測バグ（指示書の生テキストまで遡った再監査で発覚）: 項目15の最終
// ランキング画面のモックアップは「BUY SCORE/EXPECTATION/SURPRISE」だけで
// なく「UNPRICED（未織り込み度）」「TIMING（タイミング）」「RISK（低/中/
// 高）」も1銘柄ごとの独立した数値として表示する設計だった。UNPRICED/
// TIMINGはBUY SCOREの内訳（buyScore.detail.unpriced/timing）として既に
// 計算済みなのに、単独の数値としては一度も画面に出しておらず、RISKに
// 至っては相当する表示自体が存在しなかった（badChipSignals由来のリスク
// 件数はreasonBlockの箇条書きにしか出ていない）。
const RISK_LEVEL_CLS = { LOW: 'mint', MED: 'amber', HIGH: 'red' };
function riskLevel(r) {
  const n = badChipSignals(r).length;
  return n === 0 ? 'LOW' : n === 1 ? 'MED' : 'HIGH';
}
function scoreTrio(r) {
  if (!r.buyScore) return '';
  // A指示 項目24「CONFIDENCEを実質的な投資判断信頼度にする」:
  // HIGH/MEDIUM/LOWの3段階に加えUNKNOWN（根拠が弱すぎる＝BUY SCOREの
  // 5要素のうち1つもデータが揃わなかった状態）を追加する。従来は
  // confidenceTierがnull（=r.confidenceTier未設定）のとき何も表示せず
  // 黙って情報を隠していたが、それ自体が「判定材料が無い」という重要な
  // シグナルなので明示する。
  const tierCls = { HIGH: 'mint', MEDIUM: 'amber', LOW: 'red', UNKNOWN: 'gray' };
  const confidenceLabel = r.confidenceTier ?? 'UNKNOWN';
  const fmtScore = (s) => Number.isFinite(s?.score) ? s.score : '--';
  const confBadge = `<span class="chip ${tierCls[confidenceLabel]}" title="BUY SCOREの算出に使えたデータの充実度（DATA${r.buyScore.confidence}%）。低いほどEffective Score（実際の順位に使う値）がSCOREより割り引かれます。UNKNOWNはBUY SCOREの5要素のうち1つもデータが揃わなかった状態です">CONFIDENCE ${confidenceLabel}</span>`;
  const effectiveNote = Number.isFinite(r.effectiveScore) && r.effectiveScore !== r.buyScore.score
    ? ` <i title="Effective Score = BUY SCORE × CONFIDENCE係数。実際の順位はこちらを使います">実質${r.effectiveScore}</i>` : '';
  const unpriced = r.buyScore.detail?.unpriced?.value;
  const timing = r.buyScore.detail?.timing?.value;
  const risk = riskLevel(r);
  return `<div class="score-trio">
        <span class="chip flat" title="今この銘柄を仕込む価値。期待リターン30・未織り込み度25・決算サプライズ期待20・タイミング15・企業クオリティ10の100点満点">BUY ${fmtScore(r.buyScore)}${effectiveNote}</span>
        <span class="chip flat" title="企業そのものの中長期的な成長期待（売上高成長率・利益成長率・企業クオリティ・セクターモメンタム）">EXPECTATION ${fmtScore(r.expectationScore)}</span>
        <span class="chip flat" title="次回決算で市場予想を上回る可能性（会社予想とコンセンサスの差・進捗率モメンタム・月次開示の有無）">SURPRISE ${fmtScore(r.earningsSurpriseScore)}</span>
        ${Number.isFinite(unpriced) ? `<span class="chip flat" title="好材料がまだ株価に織り込まれていない度合い（BUY SCOREの内訳。妙味スコアを流用）">UNPRICED ${unpriced}</span>` : ''}
        ${Number.isFinite(timing) ? `<span class="chip flat" title="決算までの日数から見た仕込みタイミングの良さ（BUY SCOREの内訳）">TIMING ${timing}</span>` : ''}
        <span class="chip ${RISK_LEVEL_CLS[risk]}" title="bad級のリスクシグナル該当件数（0件=LOW/1件=MED/2件以上=HIGH）。詳細は下の理由欄またはリスクのチップを確認してください">RISK ${risk}</span>
        ${confBadge}
      </div>`;
}

// 市場区分チップ（プライム/スタンダード/グロース）
function marketChip(market) {
  if (!market) return '';
  return `<span class="chip gray">${esc(marketLabel(market))}</span>`;
}

// 底打ち確認（＋α）— セリングクライマックス近似・ネットネット・配当下限・
// 踏み上げ狙い・業種出遅れなどのシグナルを、該当したものだけチップで出す。
// 除外/減点には使わない（根拠を積み増す一言メモという位置づけ）。
//
// フィールド一覧はindicators.mjsのCHIP_SIGNAL_FIELDSを参照する（ここで
// 独自に列挙しない）。ambushVerdict/smartEntryVerdictも同じ一覧を見て
// いるため、新しいシグナルをCHIP_SIGNAL_FIELDSに1行足すだけでチップ表示
// とverdictへの反映が両方とも自動的に効く（「表示だけして判定側に
// 配線し忘れる」という、このセッションで2回実際に起きたバグの再発防止）。
// コンセンサス（アナリスト予想）が無い銘柄は「未来の期待値」との比較が
// そもそもできないため、代わりに「過去の事実」に基づくチップ
// （VALUATION_CHIP_FIELDS＝お宝候補・解散価値・PBR・配当）を先頭に出す。
export function bottomChips(r) {
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  const fields = hasConsensus
    ? CHIP_SIGNAL_FIELDS
    : [...VALUATION_CHIP_FIELDS, ...CHIP_SIGNAL_FIELDS.filter((k) => !VALUATION_CHIP_FIELDS.includes(k))];
  const items = fields.map((k) => r[k]).filter((s) => s && s.level);
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return items
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`)
    .join('');
}

// 「1日30分の銘柄調査ルーティン」の自分ルール（需給/下値/期待値/タイミング/
// 財務）をカード側で自動チェックする。財務（売上債権と売上高の伸び率比較）
// だけはIR Bank側に該当データが無く自動化できないため、常に「要手動確認」
// として区別する（できない判定を偽って自動化はしない）。
export function buyRuleChecklist(r) {
  const rows = [];

  // 元の自分ルールは「信用倍率が過度に高くない、または空売りが積み上がっている」
  // というOR条件。squeezeが'good'ならmarginOverhangが'bad'でも需給面の裏付け
  // ありとして扱う（踏み上げ期待の方が根拠として優先＝noteもsqueeze側を出す）。
  // marginOverhang.level:nullは「信用倍率データが無い」場合と「データは
  // あり信用過多ではないと確認できた」場合があるため、checked flagで
  // 区別する（実測: 石井表記等4銘柄はloanRatio自体が無いのに「✓ 信用過多
  // の兆候なし」＝確認済みと誤表示していた）。
  // 「信用倍率が過度に高くない、または空売りが積み上がっている」という
  // OR条件は、どちらか一方が確定的にtrueなら全体がtrue、両方とも確定的に
  // falseなら全体がfalse、それ以外（一方でも未確認）は結論を出せない
  // （厳密な3値OR論理）。以前は「marginOverhangが確定的にbadなら、
  // squeezeの状態を見ずに一律✗」としており、squeezeが単に未取得なだけ
  // （踏み上げ狙いを確認できなかった訳ではなくデータ自体が無い）でも
  // 誤って「OR全体がfalseと確定」扱いにしていた（実測: 3038神戸物産等
  // 6銘柄でmarginOverhangがbad・squeezeが週次信用残データ未取得のまま
  // 需給✗と表示されていた）。
  const supplyBad = r.marginOverhang?.level === 'bad';
  const supplyChecked = r.marginOverhang?.checked === true;
  const squeezeGood = r.squeeze?.level === 'good';
  const squeezeChecked = r.squeeze?.checked === true;
  const orConfirmedTrue = (supplyChecked && !supplyBad) || squeezeGood;
  const orConfirmedFalse = supplyChecked && supplyBad && squeezeChecked && !squeezeGood;
  let supplyNote;
  if (squeezeGood) supplyNote = r.squeeze.note;
  else if (orConfirmedTrue) supplyNote = '信用過多の兆候なし';
  else if (orConfirmedFalse) supplyNote = r.marginOverhang.note;
  else if (supplyBad) supplyNote = `${r.marginOverhang.note}（空売りデータ不足のため踏み上げの有無は未確認）`;
  else supplyNote = '信用倍率または空売りのデータが不足しています';
  rows.push({
    label: '需給', ok: orConfirmedTrue ? true : (orConfirmedFalse ? false : null),
    note: supplyNote,
  });

  // ネットネットは実測でほぼ発動しない（AMBUSH候補21銘柄中0件）ため、
  // 元の自分ルール通り「PBRが業種平均以下」も下値の裏付けとして見る
  // （netNetOk OR lowPbrOk OR pbrHistoricalLowOk というOR条件）。
  // pbrHistoricalLow（過去自身の最低PBRへの接近度）は、コンセンサスが
  // 無い銘柄向けに追加した3つ目の下値裏付け（indicators.mjs参照）。
  // netNet/lowPbr/pbrHistoricalLowのlevel:nullは「データ不足で判定
  // できない」場合と「データは揃っていて下値の裏付けは無いと確認できた」
  // 場合の両方があり得るため、checked flagで区別する（実測: 350A等11銘柄
  // はPBR・業種平均PBRのデータが完全に揃っているのに「確認できず」と
  // 表示されていた）。
  // OR条件が確定的にfalseと言えるのは「3つとも確認済みで、3つとも
  // 該当しない」場合だけ（需給行と同じ3値OR論理）。いずれかだけ確認済みで
  // 該当しない場合、他が未確認のままではOR全体を確定できない
  // （OR判定なのに「いずれか一つさえ確認できればfalse確定」としていた
  // のは論理的に誤り）。
  const netNetOk = r.netNet?.level === 'good' || r.netNet?.level === 'warn';
  const lowPbrOk = r.lowPbr?.level === 'good' || r.lowPbr?.level === 'warn';
  const pbrHistoricalLowOk = r.pbrHistoricalLow?.level === 'good';
  const netNetChecked = r.netNet?.checked === true;
  const lowPbrChecked = r.lowPbr?.checked === true;
  const pbrHistoricalLowChecked = r.pbrHistoricalLow?.checked === true;
  const downsideConfirmedFalse = netNetChecked && lowPbrChecked && pbrHistoricalLowChecked;
  const downsideNote = r.netNet?.note ?? r.lowPbr?.note ?? r.pbrHistoricalLow?.note;
  rows.push({
    label: '下値', ok: (netNetOk || lowPbrOk || pbrHistoricalLowOk) ? true : (downsideConfirmedFalse ? false : null),
    note: downsideNote ?? (downsideConfirmedFalse ? '解散価値・PBR（業種比・歴史的水準）いずれでも下値の裏付けなし' : '解散価値・PBR判定に必要なデータが不足しています'),
  });

  // 「コンセンサスN/A」と一括りにしていたが、実際には
  // ①会社予想(estimateProfit)が無い（SBI決算カレンダー側に未収録）ケースと
  // ②コンセンサス(consensusProfit)が無い（アナリスト非カバー）ケースは
  // 原因が別。どちらが欠けているかで表示を分けないと、コンセンサスは
  // あるのに会社予想が無いだけの銘柄（例: 4716日本オラクル）まで
  // 「コンセンサスN/A」と誤表示してしまう。
  // なお「会社が通期予想を非開示」と断定するのは誤り（実測: 7921は
  // kabutanの決算ページ自体には来期予想の数値が載っているのに、SBI側の
  // カレンダーには収録されていなかった）。原因を決めつけず「このデータ
  // ソースには無い」という事実だけを伝える。
  let diffPct = null;
  const hasEstimate = Number.isFinite(r.estimateProfit);
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  if (hasEstimate && hasConsensus) {
    diffPct = Math.round(((r.estimateProfit - r.consensusProfit) / Math.abs(r.consensusProfit)) * 1000) / 10;
  }
  let expectedNote;
  if (diffPct !== null) {
    expectedNote = `会社予想はコンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%`;
  } else if (!hasEstimate && hasConsensus) {
    expectedNote = '会社予想N/A（決算カレンダーに未収録）';
  } else if (hasEstimate && !hasConsensus) {
    expectedNote = 'コンセンサスN/A';
  } else {
    expectedNote = '会社予想・コンセンサス共にN/A';
  }
  rows.push({
    label: '期待値', ok: diffPct === null ? null : Math.abs(diffPct) <= 10,
    note: expectedNote,
  });

  // SMART ENTRYは決算スケジュールを見ない設計のため決算日が無い銘柄が
  // 多い（daysLeft:null）。この場合earningsWarningは常にlevel:null
  // （'bad'ではない）になり、!timingBadが常にtrueになって「決算日が
  // わからない」のに「近くないと確認できた」かのように✓を表示していた。
  // 財務行と同じく「未確認」と「確認済みで問題なし」を区別する。
  const timingBad = r.earningsWarning?.level === 'bad';
  const daysLeft = r.earningsDaysLeft ?? r.daysLeft ?? null;
  rows.push({
    label: 'タイミング', ok: daysLeft === null ? null : !timingBad,
    note: timingBad ? r.earningsWarning.note : (daysLeft !== null ? `決算まであと${daysLeft}日` : '決算日情報不明のため判定不能'),
  });

  // 売上債権(IR Bank)と売上高(kabutan)の年度成長率を自動比較。どちらか
  // 一方でも取得できない銘柄は checked:false になるため、okはnullのまま
  // 返す（「異常なし」と「判定不能」を混同しない＝未確認の「？」表示）。
  // levelが'warn'（やや増加・様子見レベル）でも「✓」を付けると、注意文言
  // (note)と結論(✓)が矛盾して見える。「異常なし」と言えるのは level が
  // 完全にnull（warnもbadも出ていない）のときだけにする。
  const fin = r.receivablesAnomaly;
  rows.push({
    label: '財務', ok: fin?.checked ? fin.level === null : null,
    note: fin?.level ? fin.note : (fin?.checked ? '売上債権の伸びは売上高に対して異常なし' : '売上高または売上債権のデータ不足で判定不能'),
  });

  return rows;
}

function ruleChecklistBlock(r) {
  const rows = buyRuleChecklist(r);
  // データ不足で判定できない項目（ok:null）はスコアの分母に入れない
  // （「不明」を「未達成」に読み替えて厳しく見せない＝仕様書§25と同じ方針）。
  const resolved = rows.filter((row) => row.ok !== null);
  const passed = resolved.filter((row) => row.ok === true).length;
  const pills = rows.map((row) => {
    const mark = row.ok === true ? '✓' : row.ok === false ? '✗' : '？';
    const cls = row.ok === true ? 'mint' : row.ok === false ? 'red' : 'gray';
    return `<span class="rule ${cls}" title="${esc(row.note)}">${mark} ${esc(row.label)}</span>`;
  }).join('');
  return `<div class="rulebox">
        <div class="rulebox-head">自分ルール <span class="rulebox-score">${passed}/${resolved.length}</span></div>
        <div class="rulebox-rows">${pills}</div>
      </div>`;
}

// 同業他社比較（提案3番目）— PER/PBR/利回りは業種平均と並べて表示する
// （fetchSectorMomentumの業種別ページに元々あった列を流用、追加取得は
// 無し）。ROEは個別銘柄のみ（kabutan側に業種平均ROEのページが無いため
// 非対応と明記する。推測で埋めない）。
function peerComparisonBlock(r) {
  const rows = [];
  if (Number.isFinite(r.per) || Number.isFinite(r.sectorPer)) {
    rows.push(['PER', fmt(r.per, '倍'), fmt(r.sectorPer, '倍')]);
  }
  if (Number.isFinite(r.pbr) || Number.isFinite(r.sectorPbr)) {
    rows.push(['PBR', fmt(r.pbr, '倍'), fmt(r.sectorPbr, '倍')]);
  }
  if (Number.isFinite(r.dividendYield) || Number.isFinite(r.sectorDividendYield)) {
    rows.push(['利回り', fmt(r.dividendYield, '%'), fmt(r.sectorDividendYield, '%')]);
  }
  if (Number.isFinite(r.roe)) {
    rows.push(['ROE', fmt(r.roe, '%'), '業種平均非対応']);
  }
  // v7.3改修 項目10: PER/PBRだけでなくEV/EBITDAも併記する（単純な
  // PER/PBR比較だけで割安・割高を判断しないという方針）。業種平均を
  // 出す仕組みが無いためROE同様「非対応」と明記する。
  if (Number.isFinite(r.evEbitda?.ratio)) {
    rows.push(['EV/EBITDA', fmt(r.evEbitda.ratio, '倍'), '業種平均非対応']);
  }
  // 時価総額も本来は同業他社比較の対象だが、業種平均時価総額を出す
  // ページがkabutan側に見当たらず非対応（ROEと同じ理由で「無い」ことを
  // 明示し、比較対象から静かに外すことはしない）。
  if (Number.isFinite(r.marketCap)) {
    rows.push(['時価総額', `${Math.round(r.marketCap / 100).toLocaleString()}億円`, '業種平均非対応']);
  }
  if (!rows.length) return '';
  return `<div class="peerbox">
        <div class="peerbox-head">同業他社比較 <span class="peerbox-sub">${esc(r.sectorName ?? '業種N/A')}</span></div>
        <table class="peer-table">
          <tr><th></th><th>個別</th><th>業種平均</th></tr>
          ${rows.map(([label, own, peer]) => `<tr><td>${esc(label)}</td><td>${own}</td><td>${peer}</td></tr>`).join('')}
        </table>
        ${ceilingPriceNote(r)}
      </div>`;
}

// netNet/lowPbr/pbrHistoricalLow・お宝候補は「下値」の裏付け（なぜ今が
// 割安か）を示すが、逆に「どこまで上がったらその裏付けが薄れるか」の
// 目安が無かった。上昇局面でこれらの緑チップだけを見ると、実際には
// 機関投資家の物色等で織り込まれつつある可能性を見落とし、「まだ割安
// だから」と高値まで買い上がるリスクがある（ユーザー指摘: 9052の
// 株価上昇局面で「割安」の根拠ばかりが並ぶ状態）。
// 業種平均PBRに現在のPBRが追いつく株価を、ファンダメンタルズ側の
// 目安として示す。overheatSignal（乖離+${OVERHEAT_KAIRI}%超の短期過熱）
// とは別の切り口であることを明記する（短期的な過熱と中長期のバリュ
// エーション上の天井は別物であり、混同すると「乖離は正常だから
// まだ買える」と誤読されるおそれがあるため）。
// 業種平均PBRに到達する株価（生の数値）。ceilingPriceNote（表示用）と
// exitPlanBlock（手放すタイミングの目安、v7.4）の両方から使う。
export function ceilingPrice(r) {
  if (![r.pbr, r.sectorPbr, r.price].every(Number.isFinite) || r.pbr <= 0) return null;
  if (r.pbr >= r.sectorPbr) return null; // 既に業種平均以上なら「割安の上限」という概念自体が成立しない
  return Math.round(r.price * (r.sectorPbr / r.pbr));
}

export function ceilingPriceNote(r) {
  const cp = ceilingPrice(r);
  if (cp === null) return '';
  return `<div class="peerbox-note">📐 バリュエーション上の目安：業種平均PBR(${r.sectorPbr}倍)に到達する株価は約${cp.toLocaleString()}円。「割安」を根拠に仕込むなら、そこに近づくほど下値の裏付けは薄れます（乖離+${OVERHEAT_KAIRI}%超の短期過熱とは別の、中長期のバリュエーション上の目安です）</div>`;
}

// 「いつまでに仕込むべきか」の目安（ユーザー要望。AMBUSH専用——SMART
// ENTRYは決算スケジュールを見ない設計のため対象外）。
// AMBUSHは決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日を「狙い目」とし、
// 決算まで${WINDOW.nowMax + 1}〜45日は様子見期間として扱っている（section C
// の説明文と同じ考え方）。カード単体でも「いつ頃までに動くべきか」が
// 分かるよう、決算の実日付とゾーンの目安をここで明記する。
//
// 実測: AMBUSH候補の半数近く(23銘柄中10銘柄)はearningsDateStatusが
// 'estimated'（取引所未確定・前年同期を置き換えた参考値）でr.earningsDate
// がnullのため、r.earningsDateのみを見ているとこれらのカードに一切
// 表示されなかった。r.earningsDateRaw（"2026/09 下旬"等の旬表記。
// sbi.mjsの参考値はこの形式で入る）を目安としてフォールバックに使う。
//
// verdictを渡すのは矛盾防止のため。「狙い目ゾーン」はdaysLeft<=30の
// 機械的な判定だが、bucket='WATCH'（daysLeft 31〜45）でもスコア70以上・
// 先行カタリストありならambushVerdictは「買い推奨」を返しうる（rankOf
// はevidenceが有ればS/Aランクを止めない。bucket分けとverdict計算は
// 別々の条件式のため）。日数だけを見て「まだ様子見期間です」と言い
// 切ると、真上の「買い推奨」バッジと矛盾する（実測ではまだ発生して
// いないが、スコア70以上かつ先行カタリストありでdaysLeftが31〜45の
// 銘柄が現れれば必ず起きる）。verdictが'buy'のときは日数に関わらず
// 狙い目メッセージを優先する。
// entryTimingNote/exitPlanBlock（v7.4）共通の決算日ラベル算出。
function earningsDateLabel(r) {
  if (r.earningsDate) {
    return new Date(`${r.earningsDate}T00:00:00+09:00`).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });
  }
  if (r.earningsDateRaw) {
    return `${r.earningsDateRaw}ごろ（前年同期からの参考値・未確定）`;
  }
  return null;
}

export function entryTimingNote(r, verdict) {
  const daysLeft = r.daysLeft;
  if (!Number.isFinite(daysLeft)) return '';
  const dateLabel = earningsDateLabel(r);
  if (dateLabel === null) return '';
  // 実測バグ（v7.3でPRE-AMBUSH＝決算まで46〜60日を新設した際の再発）:
  // verdict==='buy'を無条件の上書き条件にしていたため、決算まで53〜59日
  // というPRE-AMBUSH（まだ早期監視段階）の米国株が、rank/scoreだけで
  // 'buy'判定になった途端「決算をまたぐ新規エントリーは避け、発表前には
  // 手仕舞いを検討してください」という差し迫った文言になってしまって
  // いた（この上書きは元々、WATCH帯(31〜45日)でも強い根拠があれば
  // 'buy'になりうるケース用に設計されたもので、PRE-AMBUSH帯(46〜60日)
  // までは想定していなかった）。上書きが効く範囲をWATCH帯の上限
  // （watchMax）までに制限する。
  const inZone = daysLeft <= WINDOW.nowMax || (verdict?.level === 'buy' && daysLeft <= WINDOW.watchMax);
  const guidance = inZone
    ? `決算をまたぐ新規エントリーは避け、発表前には手仕舞いを検討してください`
    : `あと${daysLeft - WINDOW.nowMax}日ほどでAMBUSHの狙い目ゾーン（決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日）に入ります。それまでは様子見期間です`;
  return `<div class="timing-note">📅 決算発表 ${dateLabel}（あと${daysLeft}日）。${guidance}</div>`;
}

// v7.4改修（ユーザー要望）: 「いつまでに仕込むべきか」「いつどうなった
// タイミングで手放すべきか」を明示する。新しい判定ロジックは追加せず、
// 既存のWINDOW（決算までの日数）・verdict・overheatSignalの閾値
// （OVERHEAT_KAIRI）・repricingLagのzone・ceilingPrice（業種平均PBR
// 到達の目安株価）を、具体的なチェックリストとして再構成するだけ。
// AMBUSH専用（entryTimingNoteと同じ理由でSMART ENTRYは対象外——決算
// スケジュールを見ない設計のため「決算までの仕込み期限」という概念が
// 成立しない）。
export function exitPlanBlock(r, verdict) {
  const daysLeft = r.daysLeft;
  const dateLabel = earningsDateLabel(r);
  if (!Number.isFinite(daysLeft) || dateLabel === null) return '';

  // entryTimingNoteと同じ実測バグの再発防止（PRE-AMBUSH帯=決算まで
  // 46〜60日までisBuyLikeの上書きが効いてしまっていた）。上書きが効く
  // 範囲をWATCH帯の上限（watchMax=45日）までに制限する。
  const isBuyLike = (verdict?.level === 'strong_buy' || verdict?.level === 'buy') && daysLeft <= WINDOW.watchMax;
  let deadline;
  if (daysLeft < WINDOW.sweetMin && !isBuyLike) {
    deadline = `決算まであと${daysLeft}日と間近です。新規の仕込みは推奨しません（織り込み警戒ゾーン）`;
  } else if (daysLeft <= WINDOW.nowMax || isBuyLike) {
    deadline = `決算発表 ${dateLabel} の前営業日までが仕込み期限の目安です（あと${daysLeft}日）`;
  } else {
    deadline = `決算まであと${daysLeft}日。あと${daysLeft - WINDOW.nowMax}日でAMBUSHの狙い目ゾーンに入ります。仕込みはまだ早めです`;
  }

  const exits = ['決算発表の前営業日までに手仕舞う（決算をまたぐリスクを避ける）'];
  exits.push('判定が🟠織り込み警戒／🔴見送りに悪化したら手放す（次回更新時に確認）');
  if (Number.isFinite(r.kairi)) {
    exits.push(`乖離率が+${OVERHEAT_KAIRI}%を超えたら手放す（現在${r.kairi >= 0 ? '+' : ''}${r.kairi}%）`);
  }
  if (r.repricingLag?.checked) {
    exits.push('妙味ゾーンが「織り込み済み」になったら手放す');
  }
  const cp = ceilingPrice(r);
  if (cp !== null) {
    exits.push(`業種平均PBR到達の目安株価（約¥${cp.toLocaleString()}）に近づいたら利益確定を検討`);
  }

  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 仕込み期限・手放すタイミング</div>
        <div class="exit-plan-deadline">${deadline}</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.4改修（ユーザー要望「SMART ENTRYにもない」）: SMART ENTRYは決算
// スケジュールを見ない設計のため「仕込み期限」（決算まで○日）という
// 概念自体が無いが、「手放すタイミング」はAMBUSHと同じ考え方
// （verdict・overheatの閾値・バリュエーション上限）で明示できる。
// exitPlanBlockとは別関数にする（daysLeft/earningsDateが無い前提の
// ロジックのため、無理に共通化すると条件分岐が複雑になる）。
export function smartEntryExitPlanBlock(r, verdict, overheat, growthSurge, patternExpired) {
  const exits = [
    patternExpired
      ? '選定時の仕込みパターン（①②③のいずれか）に該当しなくなったら手放す（現在: 該当なし）'
      : '選定時の仕込みパターン（①②③のいずれか）に該当しなくなったら手放す',
    '判定が様子見／見送りに悪化したら手放す（次回更新時に確認）',
  ];
  if (Number.isFinite(r.kairi)) {
    exits.push(`乖離率が+${OVERHEAT_KAIRI}%を超えたら手放す（現在${r.kairi >= 0 ? '+' : ''}${r.kairi}%）`);
  }
  if (growthSurge?.level === 'bad') {
    exits.push('急騰グロース（直近1ヶ月+50%超）は既に過熱、手放しを検討');
  }
  const cp = ceilingPrice(r);
  if (cp !== null) {
    exits.push(`業種平均PBR到達の目安株価（約¥${cp.toLocaleString()}）に近づいたら利益確定を検討`);
  }
  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 手放すタイミング</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.3改修（ユーザー指示書 項目15/16）: 「なぜこの銘柄が上位に来たのか」を
// 既存の各シグナルから組み立てて表示する。新しい判定ロジックは作らず、
// 既に計算済みの値（catalystTier/repricingLag/badChipSignals/daysLeft等）
// を5カテゴリ（上昇要因/未織り込み要因/タイミング要因/リスク/次に確認
// すべきイベント）に振り分けるだけ。checkReasonConsistency（項目17）が
// この戻り値をそのまま検証できるよう、表示文字列と生データの両方を
// 保持した構造で返す。
export function buildReasons(r, verdict) {
  const up = [];
  if (r.catalystTier) up.push({ text: `先行材料${r.catalystTier}ランク（${esc(r.catalysts?.[0]?.label ?? '')}）`, kind: 'catalyst' });
  if (r.progressStreak?.level === 'good') up.push({ text: '業績の進捗率が連続上振れ', kind: 'profit_improving' });
  if (Number.isFinite(r.score) && r.score >= 70) up.push({ text: `SCORE(素点)${r.score}と高水準`, kind: 'score' });

  const unpriced = [];
  if (r.repricingLag?.checked && (r.repricingLag.zone === 'pre_move' || r.repricingLag.zone === 'early_move')) {
    unpriced.push({ text: `妙味スコア${r.repricingLag.score}/100（${REPRICING_ZONE[r.repricingLag.zone]?.label ?? r.repricingLag.zone}）`, kind: 'unpriced' });
  }

  const timing = [];
  if (Number.isFinite(r.daysLeft)) timing.push({ text: `決算まで${r.daysLeft}日`, kind: 'timing' });

  const risks = badChipSignals(r).map((s) => ({ text: s.note ?? s.label, kind: 'risk' }));

  const nextEvents = [];
  if (r.earningsDate) nextEvents.push({ text: `次回決算（${esc(r.earningsDate)}）`, kind: 'event' });
  else if (r.earningsDateRaw) nextEvents.push({ text: `次回決算（${esc(r.earningsDateRaw)}ごろ・未確定）`, kind: 'event' });

  return { up, unpriced, timing, risks, nextEvents };
}

function reasonBlock(r, verdict) {
  const reasons = buildReasons(r, verdict);
  const groups = [
    ['📈 上昇要因', reasons.up], ['🔍 未織り込み要因', reasons.unpriced],
    ['⏱ タイミング要因', reasons.timing], ['⚠️ リスク', reasons.risks],
    ['🔔 次に確認すべきイベント', reasons.nextEvents],
  ].filter(([, items]) => items.length);
  if (!groups.length) return '';
  return `<div class="reason-block">
        ${groups.map(([title, items]) => `<div class="reason-group"><span class="reason-title">${title}</span><ul>${items.map((i) => `<li>${i.text}</li>`).join('')}</ul></div>`).join('')}
      </div>`;
}

// v7.3改修 項目17: 生成した理由文と数値の整合性チェック。ユーザー例
// （「業績改善」なのに利益-19%、「買い候補」なのに重大リスクが複数ある
// 場合に警告）をそのままロジック化する。verdictはambushVerdict/
// smartEntryVerdictの`worsen()`カスケードで既にbad系シグナルがあれば
// hold以下に落ちる設計のため、通常は矛盾しないはずだが、新しいシグナルを
// 追加した際に配線を忘れる再発（ALOY repricingLagの実例）を検知する
// セーフティネットとして機能する。
export function checkReasonConsistency(r, verdict, reasons) {
  const warnings = [];
  const isBuyLike = verdict?.level === 'strong_buy' || verdict?.level === 'buy';
  if (reasons.up.some((i) => i.kind === 'profit_improving') && Number.isFinite(r.earningsTrend?.netIncomeGrowthPct) && r.earningsTrend.netIncomeGrowthPct < 0) {
    warnings.push(`上昇要因に業績改善の記述があるが、利益成長率は${r.earningsTrend.netIncomeGrowthPct}%とマイナス`);
  }
  // v7.6改修（A指示 項目25/26「売上-5%・利益-57%なのに業績改善と表示する
  // ような矛盾を禁止」の横断監査で発覚）: 上のチェックはUS側の
  // earningsTrendしか見ておらず、'profit_improving'の実際の発生源である
  // JP側のprogressStreak（buildReasonsの'up'を参照）とは一致しない
  // 組み合わせだった（progressStreak.level==='good'はprogressStreakSignal
  // 自身が既にprofitYoyPct<0ならwarnに格下げする設計のため、実際には
  // 到達し得ない「死んだ」チェックになっていた）。progressStreak側の
  // profitYoyPctも同じ意図で見ておくことで、将来progressStreakSignalの
  // 内部ロジックが変わってこの安全装置が壊れた場合にも検知できるようにする。
  if (reasons.up.some((i) => i.kind === 'profit_improving') && Number.isFinite(r.progressStreak?.profitYoyPct) && r.progressStreak.profitYoyPct < 0) {
    warnings.push(`上昇要因に業績改善の記述があるが、進捗率の裏付けとなる利益成長率は${r.progressStreak.profitYoyPct}%とマイナス`);
  }
  if (isBuyLike && r.consensusTrap?.level === 'bad') {
    warnings.push(`verdictは${verdict.label}だがconsensusTrapは期待過剰(bad)`);
  }
  if (isBuyLike && reasons.risks.length >= 2) {
    warnings.push(`verdictは${verdict.label}だがリスクが${reasons.risks.length}件検出されている（worsen()配線漏れの疑い）`);
  }
  return warnings;
}

// コンセンサス（アナリスト予想）が無い銘柄は、自分ルールの「期待値」行や
// SMART ENTRYパターン③の「コンセンサス差」が常にN/Aになる。それ自体は
// 正しい表示（存在しないデータを捏造しない）だが、代わりに参照できる
// 根拠（お宝候補・解散価値割れ・PBR・配当の「過去の事実」系シグナル。
// VALUATION_CHIP_FIELDS）が bottomChips の中に埋もれてチップのラベルだけ
// しか見えず、根拠の中身（実際の数値）はホバー時のtitle属性頼みだった。
// スマホでは長押ししないとtitleが見えないため見落としやすい。ここでは
// 常時見える形で中身をそのまま列挙する（ユーザー要望: 視覚的な分かり
// やすさ・代替根拠の記載を増やす）。
export function consensusEvidenceBlock(r) {
  const hasConsensus = hasConsensusProfit(r.consensusProfit);
  if (hasConsensus) return '';
  const items = VALUATION_CHIP_FIELDS
    .map((k) => r[k])
    .filter((s) => s && (s.level === 'good' || s.level === 'warn') && s.note);
  if (!items.length) return '';
  return `<div class="altbox">
        <div class="altbox-head">📊 コンセンサス非公開 — 代わりの根拠</div>
        <ul class="altbox-list">${items.map((s) => `<li><b>${esc(s.label)}</b>：${esc(s.note)}</li>`).join('')}</ul>
      </div>`;
}

// 配当金推移（円/株・実績）と増配/減配履歴を表示する。IR Bankの
// dividendページを既に取得済み（dividendPeak算出のため）なので、
// 追加リクエストなしで表示できる。
function dividendTrendBlock(r) {
  const yen = r.dividendYenHistory ?? [];
  if (yen.length < 2) return '';
  const trail = yen.map((y) => y.amount).join('→');
  let note;
  if (r.dividendStreakYears >= 2) {
    note = r.dividendStreakDirection === 'up'
      ? `${r.dividendStreakYears}期連続増配中`
      : `${r.dividendStreakYears}期連続減配`;
  } else {
    const last = yen.at(-1).amount;
    const prev = yen.at(-2).amount;
    note = last > prev ? '直近は増配' : last < prev ? '直近は減配' : '直近は据え置き';
  }
  return `<div class="divtrend">
        <span class="divtrend-head">配当金推移(円)</span>
        <span class="divtrend-row">${esc(trail)}</span>
        <span class="divtrend-note">${esc(note)}</span>
      </div>`;
}

// 仕込み妙味スコア（Repricing Lag、ユーザー提案）— screener.mjs/
// us_screener.mjsが計算したrepricingLag（score/zone/breakdown/生値）を
// カードに表示する。目的は「割安」の発見ではなく「業績側は改善している
// のに株価がまだ反応していない（再評価が遅れている）銘柄」を仕込み前に
// 見つけること（ユーザー指定の最重要ルール＝12番目の指示）。
// ナラティブは自然言語の完全自動生成ではなく、実測値をそのまま埋め込む
// 定型文生成（スコアの内訳を捏造しない）。zone:priced_inでもオーバー
// ライドルールの説明として表示自体は行う（除外は呼び出し側のverdictの
// 仕事であり、この関数はあくまで根拠の可視化に徹する）。
// A指示 項目6「『仕込みゾーン』を5段階に変更する」: 🟢初動前・🟢初動
// （まだ仕込める＝pre_moveと同じ「良い」系統として緑に統一）・
// 🟡再評価進行・🟠過熱警戒（新設）・🔴織り込み済みの5段階。
const REPRICING_ZONE = {
  pre_move: { emoji: '🟢', label: '初動前', cls: 'mint' },
  early_move: { emoji: '🟢', label: '初動', cls: 'mint' },
  re_rating: { emoji: '🟡', label: '再評価進行', cls: 'amber' },
  overheated: { emoji: '🟠', label: '過熱警戒', cls: 'amber' },
  priced_in: { emoji: '🔴', label: '織り込み済み', cls: 'red' },
};

function repricingLagBlock(r, { isUs = false } = {}) {
  const rl = r.repricingLag;
  if (!rl || !rl.checked || !rl.zone) return ''; // データ不足時は「無い」ことにする（捏造しない）
  const z = REPRICING_ZONE[rl.zone];
  if (!z) return '';
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : 'データ無し');
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  // 52週高値は米国株のみ取得できる（Yahoo Financeのmeta由来）。日本株は
  // 同等データを安価に取る手段が見つからなかったため、priceLevelVsRange
  // （直近60営業日＝約3ヶ月レンジでの位置）で代用する（計画時に明記済み
  // のPhase 1の非対称な扱い）。
  const priceLevelLabel = isUs ? '52週レンジ内の位置' : '直近3ヶ月レンジ内の位置（52週データの代用）';
  const growthText = Number.isFinite(rl.revenueGrowthPct) || Number.isFinite(rl.profitGrowthPct)
    ? `売上高${pct(rl.revenueGrowthPct)}${Number.isFinite(rl.profitGrowthPct) ? `・利益${pct(rl.profitGrowthPct)}` : ''}`
    : null;
  const valuationText = Number.isFinite(rl.per) && Number.isFinite(rl.sectorPer)
    ? `PER${rl.per}倍（業種平均${rl.sectorPer}倍）`
    : Number.isFinite(rl.psr) ? `PSR${r2(rl.psr)}倍` : '株価指標データ不足';

  let whyNote;
  if (rl.zone === 'priced_in') {
    whyNote = `直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}と株価が既に大きく動いており、期待が織り込まれ始めている可能性が高いため、新規の仕込み対象としては見送り推奨です。`;
  } else if (growthText) {
    whyNote = `${growthText}と業績側は改善が見られる一方、株価は直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}とまだ反応が乏しく（${priceLevelLabel}${fmt(rl.priceLevelPct, '%')}）、再評価が遅れている可能性があります。`;
  } else {
    whyNote = `株価は直近1ヶ月${pct(rl.return1m)}・3ヶ月${pct(rl.return3m)}と動いていますが、売上・利益成長率のデータが不足しており、業績改善の裏付けは確認できていません。`;
  }
  // ユーザー指定の必須項目「既に織り込まれている可能性」への言及は、
  // ゾーン判定に関係なく必ず併記する（このスコアはSNS言及数・検索急増・
  // アナリスト評価の変化・決算以外のイベントを一切見ていないため）。
  const caveat = rl.zone === 'priced_in'
    ? 'オーバーライドルール発動：直近の急騰により、内訳スコアに関係なく強制的に「織り込み済み」と判定しています。'
    : `内訳スコア${rl.score}/100点。SNS言及数・検索急増・アナリスト評価の変化・決算以外のイベントは自動取得できていないため（Phase 1の既知の限界）、実際には既に一部織り込まれている可能性もある点にご注意ください。`;

  return `<div class="repricing">
        <div class="repricing-head"><span class="chip ${z.cls}">${z.emoji} 仕込みゾーン：${z.label}</span><span class="repricing-score" title="上部のSCOREとは別軸（今から買うタイミング/織り込み度）。SCOREによる順位には使っていません">妙味スコア ${rl.score}/100</span></div>
        <ul class="repricing-fields">
          <li>${priceLevelLabel}：${fmt(rl.priceLevelPct, '%')}</li>
          <li>1ヶ月騰落率：${pct(rl.return1m)}　3ヶ月騰落率：${pct(rl.return3m)}</li>
          <li>${valuationText}</li>
          <li>成長率：${growthText ?? 'データ不足'}</li>
          <li>先行材料：${rl.hasCatalyst ? 'あり' : 'なし／未検出'}　次回決算まで：${Number.isFinite(rl.daysToEarnings) ? `あと${rl.daysToEarnings}日` : '不明'}</li>
          ${Number.isFinite(rl.repricingGap) ? `<li title="業績改善率(売上・利益成長率の平均)－株価反応率(直近の騰落率)を、レンジ内位置で割り引いた値。妙味スコアとは別の単独指標（A指示 項目3）">Repricing Gap（業績と株価の差）：${rl.repricingGap > 0 ? '+' : ''}${rl.repricingGap}pt</li>` : ''}
        </ul>
        <div class="repricing-why">${esc(whyNote)}</div>
        <div class="repricing-caveat">⚠️ ${esc(caveat)}</div>
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
    // 次回がQ1の銘柄は当期の累計実績が無く進捗率が定義上N/Aになるが、
    // 過去のQ1が年間実績に占めていた比率（決算のクセ）が分かれば
    // 「1Q発表を待たずにどの程度を期待してよいか」の参考になる。
    if (r.quarter === '1Q' && r.q1Seasonality) {
      return `進捗N/A（過去Q1平均${r.q1Seasonality.avgSharePct}%）`;
    }
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

// 順位はambushConviction（素点score＋底打ち確認/同業他社比較の裏付け
// 加点）で決まるため、素点(scoreGauge)だけを見ているとスコアが低い
// 銘柄が上位に来て矛盾しているように見える（実測で発生：3333あさひ
// score48が3038神戸物産score49より上位）。加点があるときだけ、その
// 内訳が分かる注記を素点の下に出す。
export function convictionNote(r) {
  // AMBUSH_BONUS_FIELDS/AMBUSH_PENALTY_FIELDS（screener.mjs）をそのまま
  // importして使う。以前はここに独自の信号リストをハードコードしており、
  // ambushConvictionが加点対象を追加してもここを更新し忘れる抜けが実際に
  // 起きていた（institutionalShort・majorShareholderが実スコアには
  // 反映されているのに「+pt」の内訳表示には出ていなかった）。単一の
  // 情報源にすることで構造的に再発しないようにする。
  // retailExpectationSignal（個人投資家の期待織り込み）導入でambush
  // Convictionに初めて減点が入ったため、この表示も加点だけでなく
  // 減点込みの正味の増減を出す（減点だけ表示から漏れると、同じ
  // 「表示と実スコアの不一致」バグを繰り返すことになる）。
  const bonusCount = AMBUSH_BONUS_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good').length;
  const streakBonus = (r.dividendStreakYears >= 3 && r.dividendStreakDirection === 'up') ? 1 : 0;
  const badPenaltyCount = AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'bad').length;
  const warnPenaltyCount = AMBUSH_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn').length;
  if (bonusCount === 0 && streakBonus === 0 && badPenaltyCount === 0 && warnPenaltyCount === 0) return '';
  const bonus = (bonusCount + streakBonus) * 5;
  const penalty = badPenaltyCount * 10 + warnPenaltyCount * 4;
  const net = bonus - penalty;
  const parts = [];
  if (bonusCount > 0) parts.push(`底打ち確認等の裏付け${bonusCount}件(+${bonusCount * 5}点)`);
  if (streakBonus) parts.push(`${r.dividendStreakYears}期連続増配(+5点)`);
  if (badPenaltyCount > 0) parts.push(`個人投資家の期待織り込み大${badPenaltyCount}件(-${badPenaltyCount * 10}点)`);
  if (warnPenaltyCount > 0) parts.push(`個人投資家の期待織り込み注意${warnPenaltyCount}件(-${warnPenaltyCount * 4}点)`);
  const sign = net >= 0 ? '+' : '';
  const total = (r.score ?? 0) + net;
  // 実測の「違和感」: リング表示のSCORE（素点）だけを見ると、SCOREが
  // 低い銘柄がSCOREの高い銘柄より上位に来ているように見え、順位が
  // おかしいと誤解されやすかった（例: SCORE73の銘柄がSCORE83の銘柄より
  // 上位——実際はconviction 98 vs 83で正しい）。以前は差分（+25pt）だけを
  // 表示しており、素点への加算を暗算しないと実際の順位用の値が分から
  // なかった。「順位」というラベルと、暗算不要で分かる合計値を前面に
  // 出すことで、SCOREと順位が別の指標であることをその場で示す。
  return `<div class="conviction-note${net < 0 ? ' neg' : ''}" title="順位は素点(${r.score ?? 0})に${parts.join('・')}ぶん(${sign}${net}点)を加えた${total}点で計算しています">順位${total}pt(${sign}${net})</div>`;
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
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}" title="SCORE(素点=月次30+PR30+進捗20+セクター10+テクニカル10)だけを基準にしたランクです。BUY SCORE・判定（見送り〜強い買い候補）とは別の指標のため、実際の仕込み判断はBUY SCORE・判定を優先してください">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          <div class="score-col">
            ${scoreGauge(r.score)}
            ${convictionNote(r)}
          </div>
        </header>
        ${verdictBlock(verdict)}
        ${scoreTrio(r)}
        ${entryTimingNote(r, verdict)}
        ${exitPlanBlock(r, verdict)}
        ${reasonBlock(r, verdict)}

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
          <span class="conf" title="旧SCORE（月次/PR/進捗/セクター/テクニカルの素点）算出に使えた情報量です。下のBUY SCOREのCONFIDENCE（別の5要素を基準にした信頼度）とは別の指標のため、数値が一致しないことがあります${r.confidenceRaw && r.confidenceRaw !== r.confidence ? `。方向不明の開示があるため ${r.confidenceRaw}% から ${r.confidenceRaw - r.confidence}pt 控除` : ''}">SCORE用DATA ${r.confidence ?? 0}%</span>
        </div>
        ${ruleChecklistBlock(r)}
        ${consensusEvidenceBlock(r)}
        ${peerComparisonBlock(r)}
        ${dividendTrendBlock(r)}
        ${repricingLagBlock(r, { isUs: false })}

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
          ${catalystTierBadge(r)}
          ${HORIZON_BADGE.short}
          ${opts.stale ? '<span class="chip gray">日次値</span>' : ''}
        </footer>
      </article>`;
}

// v7.3改修（ユーザー指示書 項目6）: 「先行材料あり/なし」の2値をS/A/B/C
// ランクに強弱化。r.rank（SCORE 0-100から出す銘柄ランクS/A/B/C/D）と
// 文字が重複するため、混同しないよう必ず「材料」を頭に付けて表示する。
const CATALYST_TIER_CLS = { S: 'mint', A: 'cyan', B: 'amber', C: 'gray' };

// v7.3改修（ユーザー指示書 項目13/14）: 「短期で上がりそうな株」と
// 「3〜5年で10倍を狙える株」を同じランキングに混在させない。判定ロジック
// 自体は変えず、投資期間の目安を表示に追加するだけ（AMBUSHは決算前の
// 待ち伏せなのでSHORT、SMART ENTRYは需給・出遅れ系の仕込みなのでSWING。
// テンバガーは既存の別セクション・別スコアのまま=3〜5年以上）。
const HORIZON_BADGE = {
  short: '<span class="chip flat" title="想定保有期間の目安（1〜3ヶ月）。決算前の値動きを狙う短期の仕込みです">⏱ SHORT</span>',
  swing: '<span class="chip flat" title="想定保有期間の目安（3〜12ヶ月）。需給・出遅れの解消を待つ中期の仕込みです">⏱ SWING</span>',
};
function catalystTierBadge(r) {
  if (!r.catalystTier) {
    return '<span class="chip gray" title="TDnetに好材料の開示も月次KPIも無いため、先行カタリストの根拠がありません。スコアが高くてもAMBUSH NOWには入れていません">材料なし</span>';
  }
  // 実測: 「契約締結」（Aランク・+10）と「中止」（悪材料・-14）が同一銘柄で
  // 同時に開示され、tier='A'なのに相殺後のscore100が0点になるケースが
  // あった（一見矛盾して見える）。tierは「見つかった好材料の中で最も
  // 強いもの」、score100は「悪材料も差し引いた後の正味の値」という別々の
  // 意味だと明記し、矛盾していないことが分かるようにする。
  const netNote = r.catalystScore100 === 0 && r.catalystTier
    ? '（同時に悪材料の開示もあり、正味では相殺されています）'
    : '';
  return `<span class="chip ${CATALYST_TIER_CLS[r.catalystTier]}" title="TDnet開示の中で最も強い好材料のランク（S＞A＞B＞C）。100点換算の正味スコア（悪材料と相殺後）は${r.catalystScore100 ?? '--'}点${netNote}">材料${r.catalystTier}ランク</span>`;
}

// ------------------------------------------------------------------
// SMART ENTRY専用: 仕込みパターンカード（AMBUSHのスコア/ランクは使わない）
// ------------------------------------------------------------------
// good=条件全て該当 / partial=一部該当（データ不足で確定できない）/
// none=既知の条件だけで確定的に非該当（見送ってよい） / null=判定材料が
// 何も無い総N/A。noneとnullは以前どちらもlevel:nullで区別が無く、
// 🔴（bad）が定義上ずっと到達不能なデッドコードだった（indicators.mjsの
// composePatternのコメント参照）。
const SIG_EMOJI = { good: '🟢', partial: '🟡', none: '🔴', null: '⚪' };
const SIG_CLASS = { good: 'mint', partial: 'amber', none: 'red', null: 'gray' };

export function signalRow(title, sig) {
  const emoji = SIG_EMOJI[sig.level ?? 'null'];
  const cls = SIG_CLASS[sig.level ?? 'null'];
  return `<div class="sig">
        <div class="sig-head"><span class="sig-e">${emoji}</span><span class="sig-t">${esc(title)}</span><span class="chip ${cls}">${esc(sig.label)}</span></div>
        <div class="sig-n">${esc(sig.note)}</div>
      </div>`;
}

// SMART ENTRYの順位は乖離の深さだけでなく、底打ち確認の裏付け(+15/+20)や
// 警告(-25)も加味した総合スコア(smartEntryConviction)で決めている。
// AMBUSHのscoreGauge(0-100%のリング表示)とはスケールが違う（該当
// パターン数×100が基準点なので0〜300pt程度になりうる）ため、同じ
// ビジュアルを使うと誤解を招く。数値をそのまま出すシンプルな表示にする。
function smartScoreBadge(score) {
  // SMART_ENTRY_PENALTY_FIELDS（smart_entry.mjs）に何を足しても、ここの
  // 説明文だけ更新し忘れる抜けが起きうる（実測: retailExpectationSignal
  // 追加時、この静的な説明文には反映し忘れていた）。ここは動的な内訳
  // 表示ではなく固定の一文なので配列を自動でimportして組み立てる作りには
  // していないが、SMART_ENTRY_PENALTY_FIELDSの中身が変わったら合わせて
  // このコメントと文言も見直すこと。
  return `<div class="smart-score" title="該当パターン数×100 ＋ 一部該当(+20)・底打ち確認等の裏付け1つにつき(+15) − 信用過多/連れ高/売掛金急増/決算間近/個人投資家の期待織り込み大などの警告1つにつき(-25) ＋ 業種平均PER/PBRとの比較(最大+30) の合計。乖離の深さ「だけ」では決めていません">
    <span class="smart-score-v">${score}</span><span class="smart-score-u">SCORE</span>
  </div>`;
}

export function smartEntryCard(r, i) {
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
          ${smartScoreBadge(smartEntryConviction(r))}
        </header>
        ${verdictBlock(verdict)}
        ${scoreTrio(r)}
        ${smartEntryExitPlanBlock(r, verdict, overheat, growthSurge, patternExpired)}
        ${reasonBlock(r, verdict)}

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
        ${consensusEvidenceBlock(r)}
        ${peerComparisonBlock(r)}
        ${dividendTrendBlock(r)}
        ${repricingLagBlock(r, { isUs: false })}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${bottomChips(r)}
          ${diamondBadge(r.diamond)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${explosionBadges(r)}
          ${overheat.level === 'bad' ? `<span class="chip red" title="${esc(overheat.note)}">${esc(overheat.label)}</span>` : ''}
          ${growthSurge.level === 'bad' ? `<span class="chip red" title="${esc(growthSurge.note)}">${esc(growthSurge.label)}</span>` : ''}
          ${patternExpired ? '<span class="chip red" title="選んだ時点では3つの仕込みパターンのいずれかに当てはまっていましたが、その後の値動きでどれにも当てはまらなくなりました。今から新規に買う根拠にはなりません">条件外れ</span>' : ''}
          ${HORIZON_BADGE.swing}
        </footer>
      </article>`;
}

// カタリスト予兆セクションのhasPrecursor/PRECURSOR_*_FIELDSはindicators.mjs
// に移設した（screener.mjsだけでなくsmart_entry.mjsからも同じ判定基準を
// 使い回すため。scraper.mjsに置いたままだとsmart_entry.mjsからimportする
// 際にscraper.mjs→smart_entry.mjs→scraper.mjsの循環importになってしまう）。

// 需給ワンポイント表示（ユーザー提案）。業績加速の予兆（🔮）があっても
// 信用買いが積み上がっていれば「出尽くし売り」を食らいうるため、
// 予兆カード単位で常に一目でわかるバッジを1つだけ添える。データ不足
// （checked:false）の銘柄では何も出さない（無い情報を捏造しない）。
function creditFloatBadge(cf) {
  if (!cf?.checked || !Number.isFinite(cf.occupancy)) return '';
  const cls = cf.level === 'good' ? 'is-good' : cf.level === 'bad' ? 'is-bad' : 'is-mid';
  const icon = cf.level === 'good' ? '🟢' : cf.level === 'bad' ? '🔴' : '🟡';
  const title = cf.note ?? '信用買い占有率（信用買い残 ÷ 推定浮動株数の近似値）';
  return `<div class="precursor-supply-badge ${cls}" title="${esc(title)}">${icon} 信用買い占有率 ${cf.occupancy}%</div>`;
}

// 利益の質チェック（ユーザー提案）。売掛金急増（receivablesAnomaly）が
// bad/warnの銘柄は、予兆カードの枠自体を色付けして「この銘柄はN/A評価が
// 多くても要注意」と一目でわかるようにする。
function receivablesFlagClass(r) {
  const level = r.receivablesAnomaly?.level;
  return level === 'bad' ? 'flag-bad' : level === 'warn' ? 'flag-warn' : '';
}

// カタリスト予兆セクションの並び順キー。実測バグ（ユーザー指摘「なんで
// リンガーハット1位になってるの」）: 好材料(good)も注意材料(bad/warn)も
// 同じ「該当件数」として合算していたため、売掛金急増(bad)のような
// 悪材料が付いているだけで件数が1件増え、悪材料の無い銘柄より上位に
// 来てしまっていた。goodは降順（多いほど上位）、cautionは昇順
// （悪材料が少ないほど上位）に分離する。
export function precursorRank(r) {
  return {
    good: PRECURSOR_GOOD_FIELDS.filter((k) => r[k]?.level === 'good').length,
    caution: PRECURSOR_CAUTION_FIELDS.filter((k) => r[k]?.level === 'warn' || r[k]?.level === 'bad').length,
    effective: r.effectiveScore ?? -1,
  };
}

export function precursorCard(r, i) {
  const hits = PRECURSOR_GOOD_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good');
  const cautions = PRECURSOR_CAUTION_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'warn' || s?.level === 'bad');
  // 実測（ユーザー報告: 8200リンガーハットのカタリスト予兆カードに
  // 🚪仕込み期限・手放すタイミングブロックが無い）: AMBUSH由来
  // （precursorSource==='ambush'）の銘柄はr.rank/r.daysLeft等AMBUSHの
  // フィールドを持っているのに、exitPlanBlockがcard()/usCard()にしか
  // 配線されておらず、このカードには一度も出したことが無かった。
  // 成長株予兆（precursorSource==='growth'）はrank等のAMBUSH専用
  // フィールドを持たないため、ambushVerdictを計算すると意味のない
  // 「見送り」になってしまう（rankが無いとrankOf相当の分岐がelseに
  // 落ちるため）。既存のentryTimingNoteと同じ「growthなら出さない」
  // 判定をverdict計算にも適用する。
  const verdict = r.precursorSource === 'growth' ? null : ambushVerdict(r);
  return `
      <article class="card precursor-card ${receivablesFlagClass(r)}" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${creditFloatBadge(r.creditFloat)}
        </header>
        ${verdictBlock(verdict)}
        ${scoreTrio(r)}
        ${r.precursorSource === 'growth' ? HORIZON_BADGE.swing : HORIZON_BADGE.short}

        <div class="price-row">
          <div class="price">¥${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
        </div>

        <div class="precursor-list">
          ${hits.map((s) => `<div class="precursor-item">
            <div class="precursor-item-head">🔮 ${esc(s.label)}</div>
            <div class="precursor-item-note">${esc(s.note)}</div>
          </div>`).join('')}
          ${cautions.map((s) => `<div class="precursor-item precursor-caution ${s.level === 'bad' ? 'is-bad' : 'is-warn'}">
            <div class="precursor-item-head">⚠️ ${esc(s.label)}</div>
            <div class="precursor-item-note">${esc(s.note)}</div>
          </div>`).join('')}
        </div>
        ${r.precursorSource === 'growth' ? '' : entryTimingNote(r, verdict)}
        ${r.precursorSource === 'growth' ? '' : exitPlanBlock(r, verdict)}
        ${r.precursorSource === 'growth' ? '' : reasonBlock(r, verdict)}

        <footer class="c-foot">
          ${marketChip(r.market)}
          ${diamondBadge(r.diamond)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${explosionBadges(r)}
          ${r.precursorSource === 'growth'
            ? '<span class="chip flat" title="決算スケジュールとは無関係に、東証グロース市場銘柄全体から財務データだけで探した予兆です。AMBUSH（決算まで14〜60日）の候補ではありません">成長株（東証グロース）</span>'
            : '<span class="chip flat" title="AMBUSH（決算先読み）の候補銘柄としても表示中。詳しくはそちらのカードを確認してください">AMBUSH候補にも表示中</span>'}
        </footer>
      </article>`;
}

// ------------------------------------------------------------------
// 米国株AMBUSH（Phase 1）カード。
//
//  日本株のcard()と違い、TDnet相当の先行カタリスト検出・セクター
//  モメンタム・期待値のワナが無いため、chip/verdictの作りは大幅に単純化
//  している（Phase 1の既知の制約。plan参照）。netNet/earningsTrend/
//  receivablesAnomalyのうちlevelが付いたものだけをチップとして出す
//  （CHIP_SIGNAL_FIELDSと同じ「levelがある物だけ拾う」考え方）。
// ------------------------------------------------------------------
const US_CHIP_FIELDS = ['netNet', 'earningsTrend', 'receivablesAnomaly'];

function usChips(r) {
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return US_CHIP_FIELDS.map((k) => r[k]).filter((s) => s && s.level)
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`).join('');
}

function usCard(r, i) {
  // 実測バグ（ユーザー報告）: 米国株AMBUSHにはambushVerdictによる
  // 買い推奨/様子見/見送りの結論ランプが無く、SCORE/rankだけで上位表示
  // されていた銘柄が、カード下部のrepricingLagBlock（仕込み妙味）の
  // 説明文では「見送り推奨です」と明記されており、順位と結論が矛盾して
  // 見えていた（JP AMBUSHのcard()には元々あった結論ランプがusCardには
  // 抜けていた）。JPと同じverdictBlockをここにも追加する。
  const verdict = ambushVerdict(r);
  return `
      <article class="card" style="--i:${i}">
        <span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
        <header class="c-head">
          <div class="ident">
            ${rankBadge(i)}
            <span class="code">${esc(r.code)}</span>
            ${r.rank && r.rank !== 'N/A' ? `<span class="rank r-${r.rank}" title="SCORE(素点=月次30+PR30+進捗20+セクター10+テクニカル10)だけを基準にしたランクです。BUY SCORE・判定（見送り〜強い買い候補）とは別の指標のため、実際の仕込み判断はBUY SCORE・判定を優先してください">${r.rank}</span>` : ''}
            <h2 class="name">${esc(r.name)}</h2>
          </div>
          ${scoreGauge(r.score)}
        </header>
        ${verdictBlock(verdict)}
        ${scoreTrio(r)}
        ${entryTimingNote(r, verdict)}
        ${exitPlanBlock(r, verdict)}
        ${reasonBlock(r, verdict)}

        <div class="price-row">
          <div class="price">$${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="stats">
          <div class="cell"><span class="k">乖離率<i>未織込 ${fmt(unpricedScore(r.kairi), '/10')} · ${describeKairi(r.kairi)}</i></span><span class="v ${kairiTone(r.kairi)}">${fmt(r.kairi, '%')}</span></div>
          <div class="cell"><span class="k">RSI<i>14日 · ${describeRsi(r.rsi)}</i></span><span class="v ${rsiTone(r.rsi)}">${fmt(r.rsi)}</span></div>
          <div class="cell"><span class="k">出来高Z<i>20日</i></span><span class="v ${volZTone(r.volZ)}">${fmt(r.volZ)}</span></div>
          <div class="cell"><span class="k">決算<i>あと${r.daysLeft}日</i></span><span class="v">${esc(r.earningsDate ?? '--')}</span></div>
        </div>

        <div class="meta">
          <span>${esc(r.industry ?? '業種N/A')}</span>
          <span>時価総額 ${Number.isFinite(r.marketCap) ? `$${Math.round(r.marketCap).toLocaleString()}M` : '--'}</span>
          <span>EPS予想 ${fmt(r.consensusEpsEstimate)}</span>
        </div>
        ${repricingLagBlock(r, { isUs: true })}

        <footer class="c-foot">
          <span class="chip flat" title="米国株AMBUSH（Phase 1）。TDnet相当の先行カタリスト検出・セクターモメンタムには未対応です">🇺🇸 US AMBUSH</span>
          ${usChips(r)}
          ${HORIZON_BADGE.short}
        </footer>
      </article>`;
}

// ------------------------------------------------------------------
// テンバガー候補カード（ユーザー提案）。日本株・米国株を同じ枠組みで
// 表示する。日本株はsmart_entry.mjsのscanGrowthPrecursorsが返す最小限の
// 形（code/name/price/changePct/closes/market/marketCap/tenbagger）、
// 米国株はus_screener.mjsのresults（US AMBUSHの結果そのもの、tenbagger
// フィールド付き）と形が異なるため、共通して使うフィールドだけで描画する。
// ------------------------------------------------------------------
// Tier B（中型成長株候補）専用。実測バグ: 旧版は「10倍達成に必要な
// 時価総額」を示していたが、AUR（時価総額$118億→10倍$1180億は
// Uber・Intel級で非現実的）のように数字自体が「無理だ」という抑制効果を
// 生んでいた。Tier Bは「テンバガーは無理だが2〜3倍は狙えるグロース
// 中堅株」に再定義したため、目安も2倍・3倍に変更する。
// indicators.mjs側では計算せず表示専用の値。
function midCapMultipleNote(marketCap, currency) {
  if (!Number.isFinite(marketCap)) return '';
  const fmtCap = (v) => `${currency}${Math.round(v).toLocaleString()}M`;
  return `<div class="precursor-item-note">2倍・3倍時の時価総額目安: ${fmtCap(marketCap * 2)} ／ ${fmtCap(marketCap * 3)}（テンバガー(10倍)は現実的ではありません）</div>`;
}

// A指示 項目36/37「現在の時価総額から10倍の現実性を計算」「現在時価
// 総額・10倍時時価総額・2倍時・3倍時を表示」: Tier Bの2倍・3倍目安
// （midCapMultipleNote、既存）に加え、Tier Aも含む全候補で「現在→2倍/
// 3倍/10倍」の絶対額を示す。Tier Bでも10倍時の金額をあえて表示する
// ことで「なぜ非現実的か」を数字で実感できるようにする（指示書の実例:
// AUR時価総額$118億→10倍$1,180億はUber・Intel級）。
function marketCapMultiplesNote(marketCap, currency) {
  if (!Number.isFinite(marketCap)) return '';
  const fmtCap = (v) => `${currency}${Math.round(v).toLocaleString()}M`;
  return `<div class="precursor-item-note">時価総額: 現在${fmtCap(marketCap)} → 2倍${fmtCap(marketCap * 2)} ／ 3倍${fmtCap(marketCap * 3)} ／ 10倍${fmtCap(marketCap * 10)}</div>`;
}

// A指示 項目14「『10倍可能性』と『今買う妙味』を分離」・「成長ポテン
// シャル」: 3軸を並べて表示する（仕込み妙味はrepricingLag.score・
// tenbaggerRepricingBadgeで既に別軸表示済みのため、ここでは残る2軸の
// バッジのみ追加する）。
function tenbaggerScoreTrio(r) {
  const parts = [];
  if (Number.isFinite(r.growthPotential)) {
    parts.push(`<span class="chip flat" title="成長ポテンシャル（売上高成長率×2＋成長加速ボーナス、0-100）。10倍実現可能性・今買う妙味とは別軸です">成長ポテンシャル ${r.growthPotential}</span>`);
  }
  if (Number.isFinite(r.realizability)) {
    parts.push(`<span class="chip flat" title="10倍実現可能性（現在の時価総額がTierの上限にどれだけ近いか、0-100）。小型なほど高く、上限に近いほど10倍達成に必要な絶対額が大きくなり低くなります">10倍実現可能性 ${r.realizability}</span>`);
  }
  return parts.length ? `<div class="score-trio">${parts.join('')}</div>` : '';
}

// 仕込み妙味スコアのzoneバッジ（AMBUSHカードのrepricingLagBlockと同じ
// REPRICING_ZONEマッピングを流用。「10倍ポテンシャル」（Tier A/B）とは
// 別軸の「今から買う妙味」を示す。ランキング順位には使わない
// （ユーザー要望: 2軸を混同しない）。
function tenbaggerRepricingBadge(repricingLag) {
  const z = repricingLag?.checked && repricingLag.zone ? REPRICING_ZONE[repricingLag.zone] : null;
  if (!z) return '<span class="chip gray" title="仕込みゾーン判定に必要なデータ（株価位置・成長率）が不足しています">仕込みゾーン判定不可</span>';
  const gapNote = Number.isFinite(repricingLag.repricingGap)
    ? `。Repricing Gap（業績改善率－株価反応率）${repricingLag.repricingGap > 0 ? '+' : ''}${repricingLag.repricingGap}pt`
    : '';
  return `<span class="chip ${z.cls}" title="今から買う妙味（織り込み度）。10倍ポテンシャルの判定とは別軸です。妙味スコア${repricingLag.score}/100${gapNote}">${z.emoji} ${z.label}</span>`;
}

// 株価帯フィルター（ユーザー方針）。低位株の方が10倍化までの値幅を
// 狙いやすいという考え方から、100〜700円(JP)/$1〜$7(US)を理想帯、
// 材料（先行カタリスト）が十分にあれば1500円(JP)/$15(US)まで許容する。
// 当初は警告バッジのみでランキングに残していたが、ユーザー要望
// 「株価が高いものはやはり除外して」により、この帯を外れる候補は
// テンバガー候補セクションから完全に除外する（他のセクションには影響
// しない、あくまでテンバガー候補限定のフィルター）。
const PRICE_BAND = {
  jp: { ideal: 700, hard: 1500 },
  us: { ideal: 7, hard: 15 },
};
// v7.5改修（ユーザー承認済み: 「DIAMOND該当なら価格帯フィルターをスキップ
// （時価総額上限のみ適用）」）: 株価帯フィルターは「まだ織り込まれて
// いない安い株」を掴むための粗い代理指標だが、DIAMOND（diamondSignal）
// は既にrepricingLag（妙味ゾーンpre_move/early_move）というより精密な
// 未織り込み判定を必須条件にしている。実測でIONQ（$39.52、Tier B該当・
// $16B）・135A VRAIN Solution（¥4,180、DIAMOND該当）が株価帯フィルター
// だけで表示から除外されていたことを確認したため、DIAMOND該当銘柄は
// 価格帯フィルターの対象外にする（時価総額上限は別途Tier A/Bの判定で
// 既に適用されているため、無防備にはならない）。
export function passesPriceBand(price, hasCatalyst, isUs, isDiamond = false) {
  if (isDiamond) return true;
  if (!Number.isFinite(price)) return true; // 株価データ自体が無い場合は除外の判断材料が無いので通す
  const band = isUs ? PRICE_BAND.us : PRICE_BAND.jp;
  if (price <= band.ideal) return true;
  if (price <= band.hard && hasCatalyst) return true;
  return false;
}

// 実測バグ（ユーザー報告）: Tier A 1位のG-MFS(196A)がzone:'priced_in'
// （🔴織り込み済み）なのに1位に居座り続けており、「ダッシュボードで
// 今すぐ検討できる銘柄が1位に来るべき」という目的に反していた
// （AMBUSH側のALOYと同種の問題）。ただし「10倍ポテンシャル」と
// 「今から買う妙味」を混同しないという設計方針自体は維持し、
// revenueGrowthPct降順を完全に捨てるのではなく、zone:'priced_in'の
// 銘柄だけを「同じ条件を満たす他の候補があるうちは」下に沈める
// 2段階ソート（zone優先→同groupならgrowth降順）にする。
export const tenbaggerGrowthPct = (r) => r.revenueGrowthPct ?? r.earningsTrend?.revenueGrowthPct ?? null;
export const tenbaggerPricedInRank = (r) => (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in' ? 1 : 0);

// 「爆発の3条件」（ユーザー提案: 成長加速・出来高急増ブレイクアウト・
// 浮動株薄×出来高急増）の単一の情報源。これらはTier A/B判定自体
// （時価総額・成長率25%の可否）を変えない加点シグナルで、候補内の
// 並び順だけを補正する。フィールドを追加するだけで並び順・バッジ表示の
// 両方に自動反映される（AMBUSH_BONUS_FIELDSと同じパターン）。
export const EXPLOSION_SIGNAL_FIELDS = ['growthAcceleration', 'breakoutVolume', 'floatSqueeze', 'aggressiveInvestment', 'themeMatch'];
export const explosionScore = (r) => EXPLOSION_SIGNAL_FIELDS.filter((k) => r[k]?.level === 'good').length;

export function byTenbaggerRank(a, b) {
  return tenbaggerPricedInRank(a) - tenbaggerPricedInRank(b)
    || explosionScore(b) - explosionScore(a)
    || (tenbaggerGrowthPct(b) ?? -Infinity) - (tenbaggerGrowthPct(a) ?? -Infinity);
}

// explosionScoreの内訳をカードに表示する（level:'good'の項目だけ）。
// bottomChips()と同じ{level,label,note}パターンを使い回す。
function explosionBadges(r) {
  const cls = { good: 'mint', warn: 'amber', bad: 'red' };
  return EXPLOSION_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s?.level)
    .map((s) => `<span class="chip ${cls[s.level]}" title="${esc(s.note)}">${esc(s.label)}</span>`)
    .join('');
}

// v7.4改修（ユーザー要望「反映していないところがある」）: テンバガー候補
// にも「見直す・手放すタイミング」を明示する。AMBUSH/SMART ENTRYと違い
// 決算スケジュールにもverdictにも依存しない長期（3〜5年）のテーマの
// ため、「仕込み期限」という概念は無い。既存のrepricingLagのzone・
// Tier区分をそのまま再構成するだけ。
export function tenbaggerExitPlanBlock(r) {
  const exits = [];
  if (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in') {
    exits.push('妙味ゾーンが既に「織り込み済み」です。一部利益確定を検討してください');
  } else if (r.repricingLag?.checked) {
    exits.push('妙味ゾーンが「織り込み済み」に変わったら一部利益確定を検討');
  }
  exits.push('売上高成長率が閾値（+25%）を下回ったら、テンバガー候補としての前提を見直す');
  exits.push(r.tier === 'B' || r.tier === 'C'
    ? '2倍・3倍の目安株価に達したら一部利益確定を検討（10倍は非現実的な水準のため）'
    : '時価総額が中型成長株候補(Tier B)の上限を超えたら、10倍ポテンシャルの前提が変わる点に注意');
  return `<div class="exit-plan">
        <div class="exit-plan-h">🚪 見直す・手放すタイミング</div>
        <ul>${exits.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>`;
}

// v7.3改修 項目13（TENBAGGER SCOREの「財務」「株主構成」軸）: 実測で
// 「営業CF赤字＋有利子負債過多で何%なら危険」という具体的な閾値の根拠が
// 無いため、除外条件は作らず（推測で線引きしない）、判断材料になる生の
// 事実だけを参考情報として表示する。米国株テンバガー（us_tenbagger.mjs）
// はこれらのフィールドを持たないため、値が無ければ何も表示しない。
export function tenbaggerFinancialBlock(r) {
  const notes = [];
  if (Number.isFinite(r.cash) && Number.isFinite(r.interestBearingDebt)) {
    const netCash = r.cash - r.interestBearingDebt;
    notes.push(netCash >= 0
      ? `実質無借金（現金${Math.round(r.cash).toLocaleString()}円が有利子負債${Math.round(r.interestBearingDebt).toLocaleString()}円を上回る）`
      : `有利子負債${Math.round(r.interestBearingDebt).toLocaleString()}円が現金${Math.round(r.cash).toLocaleString()}円を上回っています（希薄化・借入依存のリスクを確認してください）`);
  }
  if (Number.isFinite(r.operatingCf)) {
    notes.push(r.operatingCf >= 0
      ? `営業CFは黒字（${Math.round(r.operatingCf).toLocaleString()}円）で、成長投資を自己資金でまかなえています`
      : `営業CFが赤字（${Math.round(r.operatingCf).toLocaleString()}円）で、成長を借入・増資に頼っている可能性があります`);
  }
  const shareholderNote = r.majorShareholder?.checked && r.majorShareholder?.level === 'good' ? r.majorShareholder.note : null;
  if (!notes.length && !shareholderNote) return '';
  return `<div class="precursor-item">
            <div class="precursor-item-head">💰 財務・株主構成（参考情報。除外条件ではありません）</div>
            ${notes.map((t) => `<div class="precursor-item-note">${esc(t)}</div>`).join('')}
            ${shareholderNote ? `<div class="precursor-item-note">${esc(shareholderNote)}</div>` : ''}
          </div>`;
}

function tenbaggerCard(r, i) {
  const isUs = r.tenbaggerSource === 'us';
  const currency = isUs ? '$' : '¥';
  // A指示 項目13「米国テンバガーTierを3段階にする」: Tier C（$10B〜$20B
  // 程度・大型化後の超成長株。米国株のみ、JP側には存在しない）を追加。
  const tierBadge = r.tier === 'C'
    ? '<span class="chip amber" title="時価総額$10B〜$20B程度(米国のみ)の枠。10倍（テンバガー）は非現実的ですが、既に大型化した後も高成長が続けば2〜3倍程度を狙える超成長株として監視する枠です">🏢 大型超成長株(Tier C)</span>'
    : r.tier === 'B'
    ? '<span class="chip amber" title="時価総額300億〜1000億円(日本)/$1B〜$10B(米国)の枠。10倍（テンバガー）は非現実的ですが、日本は2〜3倍・米国は2〜5倍程度の成長余地を狙えるグロース中堅株です">🌱 中型成長株候補(Tier B)</span>'
    : '<span class="chip mint" title="低時価総額×高成長率の、本来のテンバガー候補の枠">🚀 テンバガー候補(Tier A)</span>';
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

        <div class="price-row">
          <div class="price">${currency}${r.price?.toLocaleString() ?? '--'}</div>
          <div class="chg ${r.changePct >= 0 ? 'up' : 'down'}">
            <span class="arrow">${r.changePct >= 0 ? '▲' : '▼'}</span>${Math.abs(r.changePct ?? 0)}%
          </div>
          ${generateSparkline(r.closes, r.code)}
        </div>

        <div class="precursor-list">
          <div class="precursor-item">
            <div class="precursor-item-head">💎 ${esc(r.tenbagger.label)}</div>
            <div class="precursor-item-note">${esc(r.tenbagger.note)}</div>
            ${r.tier === 'B' || r.tier === 'C' ? midCapMultipleNote(r.marketCap, currency) : ''}
            ${marketCapMultiplesNote(r.marketCap, currency)}
          </div>
          ${tenbaggerScoreTrio(r)}
          ${tenbaggerFinancialBlock(r)}
        </div>
        ${tenbaggerExitPlanBlock(r)}

        <footer class="c-foot">
          ${isUs ? marketChip(null) : marketChip(r.market)}
          <span class="chip flat">${isUs ? '🇺🇸 米国株' : '🇯🇵 日本株'}</span>
          ${tierBadge}
          ${diamondBadge(r.diamond)}
          ${deficitGrowthBadge(r.deficitGrowth)}
          ${growthAnomalyCautionBadge(r.growthAnomalyCaution)}
          ${tenbaggerRepricingBadge(r.repricingLag)}
          ${explosionBadges(r)}
          <span class="chip flat" title="時価総額（${isUs ? '百万USD' : '百万円'}）">時価総額 ${currency}${Math.round(r.marketCap).toLocaleString()}M</span>
        </footer>
      </article>`;
}

// v7.5改修（ユーザー提案「テーマ性×小型×高成長×未織り込みが揃ったら
// DIAMONDにする」）。通常のtierBadge（🚀/🌱）と見分けやすいよう専用の
// 色（diamond、CSSでグラデーションを付ける）にする。
function diamondBadge(diamond) {
  if (diamond?.level !== 'good') return '';
  return `<span class="chip diamond" title="${esc(diamond.note)}">${esc(diamond.label)}</span>`;
}

// A指示 項目10/11「赤字成長特例」「赤字成長・高リスク」。levelがgood/bad
// どちらの場合も表示する（テンバガー候補で赤字企業の場合のみchecked:true
// になるため、黒字企業のカードには何も表示されない）。
function deficitGrowthBadge(deficitGrowth) {
  if (deficitGrowth?.level !== 'good' && deficitGrowth?.level !== 'bad') return '';
  const cls = deficitGrowth.level === 'good' ? 'mint' : 'red';
  return `<span class="chip ${cls}" title="${esc(deficitGrowth.note)}">${esc(deficitGrowth.label)}</span>`;
}

// A指示 項目8「異常成長・要確認」（level:warn）/「本物の成長」
// （level:good）。levelがwarn/goodどちらの場合も表示する（異常成長の
// 閾値未満の銘柄はchecked:falseのままなので何も表示されない）。
function growthAnomalyCautionBadge(growthAnomalyCaution) {
  if (growthAnomalyCaution?.level !== 'good' && growthAnomalyCaution?.level !== 'warn') return '';
  const cls = growthAnomalyCaution.level === 'good' ? 'mint' : 'amber';
  return `<span class="chip ${cls}" title="${esc(growthAnomalyCaution.note)}">${esc(growthAnomalyCaution.label)}</span>`;
}

// 初心者向けガイド（色・記号・専門用語の意味）。
//
// 実測: カードには乖離率・RSI・信用残・PBR/PER・SCORE・自分ルールの
// 需給/下値/期待値/タイミング/財務など、説明が無いと分からない専門用語が
// 多数出てくるが、その意味を示す場所がページ内のどこにも無かった
// （チップの説明はtitle属性=ホバー/スマホでは長押し頼みで、初見では
// 気づきにくい）。ユーザー要望「初心者にとって視覚情報・説明文章が
// 分かりにくい所を分かりやすくして」に対応し、常時アクセスできる用語
// ガイドを追加する。<details>はJS無しで開閉でき、初回は開いた状態にして
// 存在に気づきやすくする（voidなdisabledは無いのでopen属性で対応）。
export function beginnerGuide() {
  return `<details class="guide" open>
    <summary>🔰 初心者ガイド — 色・記号・用語の見方（タップで折りたたみ）</summary>
    <div class="guide-body">
      <div class="guide-col">
        <div class="guide-h">色・記号の意味</div>
        <ul class="guide-list">
          <li><span class="chip mint">緑（mint）</span>プラス材料・条件クリア</li>
          <li><span class="chip amber">黄（amber）</span>中立〜軽い注意</li>
          <li><span class="chip red">赤（red）</span>明確な警戒サイン</li>
          <li><span class="chip gray">灰色（gray）</span>データ不足で未確認。「悪い」という意味ではありません</li>
          <li>「自分ルール」の <b>✓</b>＝条件クリア　<b>✗</b>＝条件を満たさない　<b>？</b>＝判定に必要なデータが無い（不合格ではありません）</li>
          <li>信号🟢🟡🔴⚪も同じ考え方（🔴＝そのパターンには明確に該当しない、⚪＝判定材料が無い）</li>
        </ul>
      </div>
      <div class="guide-col">
        <div class="guide-h">よく出てくる指標</div>
        <ul class="guide-list">
          <li><b>乖離率</b>：25日移動平均線から株価がどれだけ離れているか。プラスが大きいほど「短期的に買われすぎ」の目安</li>
          <li><b>RSI</b>：買われすぎ・売られすぎを0〜100で表す指標。目安70超で買われすぎ、30未満で売られすぎ</li>
          <li><b>信用残</b>：個人投資家の信用取引（借りたお金や株で売買する仕組み）の残高。急増は個人の期待の高まりのサイン</li>
          <li><b>PBR</b>：株価が「会社を今解散した場合の取り分（純資産）」の何倍かを示す指標。1倍未満は理論上「割安」の目安</li>
          <li><b>PER</b>：株価が「1年分の利益」の何倍かを示す指標。業種平均と比べて割安・割高を判断します</li>
          <li><b>SCORE</b>：総合評価点。AMBUSHは0〜100点満点、SMART ENTRYは複数の根拠を積み上げる仕組みのため100点を超えることがあります</li>
          <li><b>順位とSCOREの違い</b>：カード左上の順位は、SCOREにチップの裏付け・警告ぶんの加減点（「順位◯pt(+N)」の表示）を加えた値で決まります。そのため、SCOREが低いカードがSCOREの高いカードより上位に来ることがあります（意図的な仕様で、順位ずれではありません）</li>
          <li><b>DATA</b>：スコア算出に使えた情報の充実度（%）。100%未満は一部の情報が欠けている状態です</li>
        </ul>
      </div>
      <div class="guide-col">
        <div class="guide-h">「自分ルール」5項目</div>
        <ul class="guide-list">
          <li><b>需給</b>：信用取引が過熱していないか・踏み上げ（買い戻し）の可能性</li>
          <li><b>下値</b>：解散価値やPBRから見て、これ以上下がりにくいと言える水準か</li>
          <li><b>期待値</b>：会社自身の予想とアナリスト予想（コンセンサス）の差</li>
          <li><b>タイミング</b>：決算発表が近すぎて新規に手を出しにくい時期でないか</li>
          <li><b>財務</b>：売上債権（売掛金）が売上に対して異常に増えていないか</li>
        </ul>
      </div>
    </div>
  </details>`;
}

// ユーザー要望「セクションごとに折りたたみ機能を追加して」に対応し、
// <section>を<details>に変え、見出し部分(sec-head)を<summary>にする。
// beginnerGuide()の.guideで既に確立済みの「▾アイコン＋sessionStorageで
// 開閉状態を覚える」パターンをセクション単位に一般化する（下のscript内
// のsectionOpen処理を参照）。
// ユーザー要望「セクションをカテゴリの右上に書いて。ワク作って」に対応。
// SECTION A/B/Cは「場中にライブ更新する対象か」を表す内部用語だったが
// UI上には一切表示されておらず、ユーザーがこれを見つけられなかった
// （前回のやり取り参照）。該当する3カテゴリ（AMBUSH NOW=A/SMART
// ENTRY=B/AMBUSH WATCH=C）の見出し右上に、枠付きバッジとして明示する。
const sectionBadge = (label) => label ? `<span class="sec-badge">SECTION ${label}</span>` : '';
const section = (id, icon, title, desc, cards, empty, sectionLabel = null) => `
  <details class="sec" id="${id}" open>
    <summary class="sec-head">
      <h2><span class="ico">${icon}</span>${title}</h2>
      ${sectionBadge(sectionLabel)}
      <p>${desc}</p>
    </summary>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">${empty}</div>`}
  </details>`;

// ==================================================================
// 出力前の自己監査 — 「赤チップ（bad）を出しているのに買い推奨」の
// ような、このセッション中に何度も見つかった矛盾を毎回の生成時に自動で
// 検出する。これまでは手作業でPythonスクリプトを書いて確認していたが、
// 新しい赤旗シグナルを追加した開発者がverdict側への配線を忘れる
// （growthSurge・上場廃止で実際に起きた）のを機械的に防ぐための恒久策。
// 誤検出で日次バッチが止まると本末転倒なので、ファイル書き込みは止めず
// コンソールに大きく警告を出すだけにする（holidays.mjs等と同じ「警告は
// するが処理は止めない」方針）。
// 自分ルールの「✓/✗」マークは"rule mint"/"rule red"クラスで出る（"rule gray"
// が「？」＝未確認）。titleに「データが無い/確認できない」旨の文言が入って
// いるのに✓/✗が付いていたら、「未確認」と「確認済み」を混同する再発
// バグ（実測: 需給・下値で発見）を検出する。
const UNCONFIRMED_NOTE_PATTERN = /データが?(不足|無い|ありません)|確認できず|判定不能|情報不明|情報なし|未収録|非開示/;

export function auditGeneratedHtml(html) {
  const cards = html.match(/<article class="card.*?<\/article>/gs) ?? [];
  const issues = [];
  for (const c of cards) {
    const code = c.match(/<span class="code">([^<]*)<\/span>/)?.[1] ?? '?';
    const name = c.match(/<h2 class="name">([^<]*)<\/h2>/)?.[1] ?? '?';

    // 「買い推奨」と同居してはいけない赤チップは、実際に警告を意味する
    // footer（bottomChips・警告チップ）側だけを見る。SMART ENTRYの
    // .signals（sig1〜3）に出る🔴は「このパターンは非該当」という意味で
    // あって警告ではなく、他のパターンが該当していれば「買い推奨」と
    // 正常に同居する（実測: sig1が非該当・sig2が該当のSMART ENTRY銘柄を
    // 誤検知していた。composePatternのlevel:'none'導入で🔴が初めて実際に
    // 出るようになった際に発覚）。
    const footer = c.match(/<footer class="c-foot">[\s\S]*?<\/footer>/)?.[0] ?? '';
    if (c.includes('買い推奨') && footer.includes('chip red')) {
      issues.push(`${code} ${name}: 買い推奨なのに赤チップ（bad級シグナル）が同居しています`);
    }

    // 実測バグの再発防止: bucket分け（daysLeft<=30かどうか）とambush
    // Verdictの「買い推奨」判定は別々の条件式のため、daysLeftが31〜45
    // でもスコア70以上・先行カタリストありなら「買い推奨」になりうる。
    // entryTimingNoteがverdictを見ずに日数だけで「様子見期間です」と
    // 言い切ると、カード上部の「買い推奨」バッジと直接矛盾する
    // （entryTimingNote側でverdictを見て回避する実装にしたが、この
    // 監査でも独立に検知できるようにしておく）。
    if (c.includes('買い推奨') && c.includes('様子見期間です')) {
      issues.push(`${code} ${name}: 買い推奨なのにentryTimingNoteが「様子見期間です」と矛盾した案内をしています`);
    }

    for (const m of c.matchAll(/<span class="rule (mint|red)" title="([^"]*)">/g)) {
      if (UNCONFIRMED_NOTE_PATTERN.test(m[2])) {
        issues.push(`${code} ${name}: 自分ルールの✓/✗表示なのにtitleが「未確認」を示唆しています（"${m[2]}"）`);
      }
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ 自己監査で矛盾を検出しました（新しい赤旗シグナルをverdict側に配線し忘れていないか、checked flagの扱いを確認してください） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return { totalCards: cards.length, issues };
}

// これらのシグナルは「データ不足で判定できない(checked:false)」と
// 「データは揃っていて該当なしと確認できた(checked:true)」を区別する
// 設計になっている（netNet/lowPbr/marginOverhang/receivablesAnomaly）。
// signal関数の実装を直しても、既にキャッシュ済みのJSONに残っている
// 古い形（checkedフィールドが無い）を再計算し忘れると、矛盾は起きない
// もののbuyRuleChecklistが必要以上に「？」を出し続ける（実測: AMBUSH側の
// キャッシュだけ再計算し、SMART ENTRY側のキャッシュを更新し忘れていた）。
// これは「表示が壊れる」バグではなく検出しにくいため、キャッシュの
// シグナル形状そのものを検証してコンソールに警告する。
// pbrHistoricalLowはnetNet/lowPbrと同じchecked flagパターンで実装した
// （buyRuleChecklistの「下値」行の3値OR条件に組み込むため）。ここへの
// 追加を忘れると、このファイル自身が防ごうとしている「checked flag無し
// の古いキャッシュを検出できない」抜けを新しいシグナルで再生産する。
const CHECKED_AWARE_FIELDS = [
  'netNet', 'lowPbr', 'marginOverhang', 'receivablesAnomaly', 'pbrHistoricalLow', 'retailExpectation',
  'progressStreak', 'dividendPotential', 'hiddenAsset', 'creditFloat', 'consensusTrap', 'earningsTrend',
  'tenbagger',
  // v7.5改修（再発防止策の横断監査で発覚）: growthAcceleration/themeMatch/
  // diamondも{level,label,note,checked}の同じ形で追加したのに、この
  // ファイル自身が防ごうとしている「checked flag無しの古いキャッシュを
  // 検出できない」抜けをここへの追記漏れで再生産していた。
  'growthAcceleration', 'themeMatch', 'diamond',
  // A指示 項目10/11で追加したdeficitGrowth（赤字成長特例/赤字成長・
  // 高リスク）も同じ{level,label,note,checked}パターン。追記忘れの
  // 再発防止のため、上と同じコメントを繰り返す代わりにここへ追加する。
  'deficitGrowth',
  // A指示 項目8で追加したgrowthAnomalyCaution（異常成長・要確認/本物の
  // 成長）も同じパターン。
  'growthAnomalyCaution',
];

export function auditSignalShapes(results, sourceLabel) {
  const issues = [];
  for (const r of results ?? []) {
    for (const key of CHECKED_AWARE_FIELDS) {
      const s = r[key];
      if (s && typeof s === 'object' && 'level' in s && typeof s.checked !== 'boolean') {
        issues.push(`[${sourceLabel}] ${r.code} ${r.name}: ${key}にchecked flagが無い古い形のままキャッシュされています（再計算漏れの疑い）`);
      }
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ キャッシュのシグナル形状が古いままです（checked flag追加後の再計算漏れ） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return issues;
}

// v7.3改修 項目17: 生成した理由文と数値の矛盾をバッチ全体で検知する
// （auditSignalShapesと同じ「実行のたびに自己点検してconsole.errorに
// 出す」パターン）。verdictFnはambushVerdict/smartEntryVerdictのどちらか
// （呼び出し側の性質に合わせる）。
export function auditReasonConsistency(results, verdictFn, sourceLabel) {
  const issues = [];
  for (const r of results ?? []) {
    const verdict = verdictFn(r);
    const reasons = buildReasons(r, verdict);
    for (const msg of checkReasonConsistency(r, verdict, reasons)) {
      issues.push(`[${sourceLabel}] ${r.code} ${r.name}: ${msg}`);
    }
  }
  if (issues.length) {
    console.error('⚠️⚠️⚠️ 生成した理由文と数値が矛盾している銘柄があります（verdict配線漏れの疑い） ⚠️⚠️⚠️');
    for (const msg of issues) console.error(`   - ${msg}`);
  }
  return issues;
}

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
  console.log('🚀 STEALTH v7.3 "AMBUSH + SMART ENTRY" 起動');
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
  // 米国株AMBUSH（ユーザー要望）。米国市場が動くのはJST深夜〜早朝のため、
  // JP市場時間限定の5分間隔ジョブには乗せず、日次パート（07:00ジョブ）
  // 側で1日1回更新する。runUsScreen自身がcache.date===todayで日中の
  // 再実行を無料化するため、ここで無条件に呼んでも実害は無い（sbi/td/
  // amb/smartと同じ設計）。
  const us = await runUsScreen({ today, force: FORCE });
  // v7.3改修（ユーザー指示書 項目1/2/7/19）: BUY/EXPECTATION/SURPRISE
  // スコアとDATA/CONFIDENCE/Effective Scoreを、ソート・カード描画の
  // どちらからも同じ値を参照できるよう、結果配列にあらかじめ1回だけ
  // 計算して埋め込む（sort()内で毎回再計算すると同じ値を何度も計算する
  // 無駄が出るため）。
  const attachScores = (results) => results.map((r) => {
    const parts = buildScoreParts(r);
    const buy = buyScore(parts.buy, buyScoreRiskPenalty(r));
    return {
      ...r,
      buyScore: buy,
      expectationScore: expectationScore(parts.expectation),
      earningsSurpriseScore: earningsSurpriseScore(parts.surprise),
      confidenceTier: confidenceTier(buy.confidence),
      effectiveScore: effectiveScore(buy.score, buy.confidence),
    };
  });
  amb.results = attachScores(amb.results ?? []);
  us.results = attachScores(us.results ?? []);
  // v7.4改修（ユーザー要望「仕込み度と成長性を完全分離する」）: SMART
  // ENTRYの結果オブジェクトにも、buildScoreParts/buyScore/expectationScore
  // が参照するフィールド（revenueGrowthPct/repricingLag等）を露出させた
  // ため、AMBUSHと同じattachScoresがそのまま使える。r.score/r.daysLeft/
  // r.consensusTrapはSMART ENTRYに存在しないため該当partsはnullのまま
  // 縮退する（既存の設計通り）。
  smart.results = attachScores(smart.results ?? []);
  // テンバガー探索（決算日非依存）。AMBUSH（米国株、決算日依存）とは
  // 完全に分離した独立スキャン。手動キュレーションリストのみを対象と
  // するため軽量で、runUsScreenと同様ここで無条件に呼んでも実害は無い。
  const usTenbagger = await runUsTenbaggerScreen({ today, force: FORCE });
  auditSignalShapes(amb.results, 'AMBUSH');
  auditSignalShapes(smart.results, 'SMART ENTRY');
  auditSignalShapes(smart.growthPrecursors ?? [], '成長株予兆');
  auditSignalShapes(smart.tenbaggerCandidatesA ?? [], 'テンバガー候補Tier A(JP)');
  auditSignalShapes(smart.tenbaggerCandidatesB ?? [], 'テンバガー候補Tier B(JP)');
  auditSignalShapes(us.results ?? [], '米国株AMBUSH');
  auditSignalShapes(usTenbagger.results ?? [], 'テンバガー候補(US)');
  // v7.3改修 項目17: 理由文と数値の矛盾チェック（自動生成した「なぜこの
  // 順位か」がverdictと食い違っていないかの自己点検）。
  auditReasonConsistency(amb.results, ambushVerdict, 'AMBUSH');
  auditReasonConsistency(us.results ?? [], ambushVerdict, '米国株AMBUSH');
  auditReasonConsistency(smart.results, (r) => smartEntryVerdict(r, overheatSignal(r.kairi), growthSurgeSignal(r.market, r.closes)), 'SMART ENTRY');

  if (DAILY_ONLY) {
    console.log(`✅ 日次パート完了 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
    return;
  }

  // ---- SECTION A / C: AMBUSH（上位のみ場中も価格更新）---------------
  // NOW = 先行カタリストありの本命。
  // SECTION C には 決算まで31〜45日(WATCH) だけでなく、NOW条件を満たさなかった
  // 決算まで7〜30日(NEAR) も入れる。ゲートで落ちた銘柄を画面から消してしまうと
  // 「Stage 1 を通過した銘柄が何だったのか」が追えなくなるため。
  // 先行カタリストを持つものを上に、次にスコア順。
  // nowも後段のlive選定（AMBUSH_LIVE件に絞って価格更新）で使うため、
  // filter直後の未整列のままにせず、ここでconviction順にしておく
  // （NOW該当が稀に12件を超えた場合、整列していないと価格更新対象の
  // 選定が実質ランダムな順序になってしまう）。
  const now = amb.results
    .filter((r) => r.bucket === 'NOW')
    .sort((a, b) => ambushConviction(b) - ambushConviction(a));
  const later = amb.results
    .filter((r) => r.bucket !== 'NOW' && r.bucket !== 'PRE')
    .sort((a, b) => (b.evidence === true) - (a.evidence === true) || (ambushConviction(b) - ambushConviction(a)))
    .slice(0, AMBUSH_WATCH_MAX);
  // NOW条件（確定日・SCORE70以上）は満たさなかったが、TDnetに好材料の開示や
  // 月次KPIなど「先行カタリストの根拠」があるものだけを仕込み候補として分離する。
  // 根拠が無い銘柄はスコアが高くても、進捗率/セクター/テクニカルだけで
  // 積み上がった数字なので参考程度（section()のグループ分けで可視化）。
  const laterEvidence = later.filter((r) => r.evidence);
  const laterNoEvidence = later.filter((r) => !r.evidence);
  // v7.3改修 項目5: PRE-AMBUSH（決算まで46〜60日、早期監視）。WATCHと
  // 同じ「先行カタリストの有無」基準で仕込み候補/参考に分ける（新しい
  // 判定軸を増やさず、既存のevidenceベースの分類をそのまま流用する）。
  const pre = amb.results
    .filter((r) => r.bucket === 'PRE')
    .sort((a, b) => (b.evidence === true) - (a.evidence === true) || (ambushConviction(b) - ambushConviction(a)))
    .slice(0, AMBUSH_WATCH_MAX);
  const preEvidence = pre.filter((r) => r.evidence);
  const preNoEvidence = pre.filter((r) => !r.evidence);
  // NOW該当だけでAMBUSH_LIVE件を超えることは今のところ実測で起きていない
  // （NOWは決算間近＋SCORE70以上＋根拠ありという厳しいAND条件のため）。
  // 起きた場合はlater側が一切価格更新されなくなり見た目に気づきにくいため、
  // 想定外の事態として警告だけ出しておく。
  if (now.length > AMBUSH_LIVE) {
    console.error(`  ⚠️ AMBUSH NOW該当が${now.length}件でAMBUSH_LIVE(${AMBUSH_LIVE})を超えています。WATCH側が価格更新されません`);
  }
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
  const verdictRank = (r) => VERDICT_SEVERITY[ambushVerdict(r).level] ?? VERDICT_SEVERITY.hold;
  // v7.3改修 項目19: 「BUY SCORE→未織り込み度→サプライズ→タイミング→
  // CONFIDENCE」の優先順位で同一verdict内を並べる。verdict（結論）自体を
  // 最優先の基準にする設計は維持する（「高SCORE＋様子見」が「低SCORE＋
  // 強い買い候補」より上位に来る矛盾を避けるため。項目19後半の注記）。
  const scoreRank = (r) => ({
    effective: r.effectiveScore ?? -1,
    unpriced: r.buyScore?.detail?.unpriced?.value ?? -1,
    surprise: r.buyScore?.detail?.surprise?.value ?? -1,
    timing: r.buyScore?.detail?.timing?.value ?? -1,
  });
  const byVerdict = (a, b) => {
    const rankDiff = verdictRank(a) - verdictRank(b);
    if (rankDiff !== 0) return rankDiff;
    const sa = scoreRank(a), sb = scoreRank(b);
    return (sb.effective - sa.effective)
      || (sb.unpriced - sa.unpriced)
      || (sb.surprise - sa.surprise)
      || (sb.timing - sa.timing)
      || (ambushConviction(b) - ambushConviction(a));
  };
  now.sort(byVerdict);
  laterEvidence.sort(byVerdict);
  laterNoEvidence.sort(byVerdict);
  preEvidence.sort(byVerdict);
  preNoEvidence.sort(byVerdict);
  // 実測バグ（ユーザー報告）: 米国株AMBUSHはus_screener.mjs側でSCORE降順
  // にしか並んでおらず、verdict（買い推奨/様子見/見送り）による並び替えが
  // 一切行われていなかった。ALOYがSCORE 70で1位表示されながら、
  // ambushVerdictは（上で追加したrepricingLag.zone==='priced_in'の
  // 配線により）見送りと判定するのに、順位はそれを一切反映しないという
  // 矛盾があった。JPのnow/later同様、verdict最優先→同verdict内は
  // ambushConviction降順で並べ直す。
  us.results = (us.results ?? []).sort(byVerdict);

  // ---- カタリスト予兆セクション ---------------------------------
  // 元々はAMBUSHが既に取得済みのデータ（対象は決算まで7〜60日の銘柄）
  // だけが対象だったが、ユーザー要望「成長株にも入れて欲しい」に対応し、
  // smart_entry.mjsが東証グロース市場銘柄全体から出来高・時価総額で
  // 絞り込んで別途スキャンした結果（smart.growthPrecursors）も合流させる。
  //
  // 実測バグ（ユーザー指摘「カタリスト予兆でなんでリンガーハット1位に
  // なってるの」）: 旧ロジックは好材料の予兆(good)も注意予兆(bad/warn)も
  // 同じ「該当件数」として合算し降順に並べていたため、「売掛金急増
  // (bad)」のような悪材料が付いているだけで件数が1件増え、悪材料の無い
  // 銘柄より上位に来てしまっていた（実測: 8200リンガーハット・
  // 3608TSI・6505東洋電機はいずれも「進捗率加速(good)×1＋売掛金急増
  // (bad)×1＝2件」で、進捗率加速だけ(good×1＝1件)の6469・7607・4187
  // より上に来ていた。悪材料の有無で順位が入れ替わっていない状態）。
  // good件数は引き続き降順（多いほど上位）にしつつ、caution件数は
  // 昇順（悪材料が少ないほど上位）に直し、さらに同点の場合はAMBUSH由来
  // ならeffectiveScore（BUY SCORE×CONFIDENCE係数）でも並べる。
  const precursors = [
    ...amb.results.filter(hasPrecursor).map((r) => ({ ...r, precursorSource: 'ambush' })),
    ...(smart.growthPrecursors ?? []).map((r) => ({ ...r, precursorSource: 'growth' })),
  ].sort((a, b) => {
    const ra = precursorRank(a), rb = precursorRank(b);
    return (rb.good - ra.good) || (ra.caution - rb.caution) || (rb.effective - ra.effective);
  });

  // ---- テンバガー候補セクション（ユーザー提案、Tier A/B 2階建て）---
  // 決算日には一切依存しない（AMBUSHとは完全分離）。日本株は
  // smart_entry.mjsの東証グロース向け成長株予兆スキャンから、米国株は
  // us_tenbagger.mjsの決算日非依存キュレーションリストスキャンから、
  // どちらも既にTier A(tenbaggerSignal: 低時価総額×高成長率、本来の
  // テンバガー候補)/Tier B(midCapGrowthSignal: 300億〜1000億円/
  // $1B〜$10Bの、10倍は非現実的だが2〜3倍は狙えるグロース中堅株)
  // で絞り込み済みのものを合流させる（追加のフィルタ・リクエストは無い）。
  // 日本株(百万円)と米国株(百万USD)は通貨単位が異なり、時価総額を
  // そのまま数値比較すると円建ての値が見かけ上大きくなり公平な順位に
  // ならないため、市場をまたいだ時価総額比較はしない。各Tier内は
  // 仕込みゾーンが🔴織り込み済みの銘柄を下位に回した上でrevenueGrowthPct
  // （成長ポテンシャルの強さの目安）降順に日本株→米国株の順で連結する
  // （byTenbaggerRank参照。ユーザー報告: Tier A 1位のG-MFSがzone:
  // 'priced_in'なのに1位に居座り続けていた問題の再発防止）。
  // JP側はrevenueGrowthPctを直接、US側はearningsTrend.revenueGrowthPctに
  // 持つ（データソースの構造差。us_tenbagger.mjs参照）。
  // 実測バグ: 以前はここで件数を切らず、Tier A/Bの小見出し・HUDの
  // 「💎テンバガー」件数バッジには未カットの合計（例: Tier B 11件）を
  // 表示しながら、カード自体はrender呼び出し側の.slice(0, RANK_TOP_N)で
  // 10件までしか出しておらず、「(11件)」と見出しに書いてあるのにカードは
  // 10枚しか無い、という表示上の矛盾が発生していた。AMBUSH WATCH（later
  // 変数）が既にconst定義時点で.slice(0, AMBUSH_WATCH_MAX)している
  // パターンに揃え、ここで一度だけ切ることで見出し・HUD・カード枚数を
  // 常に一致させる。
  // 株価帯フィルター（ユーザー要望「株価が高いものはやはり除外して」）。
  // テンバガー候補セクション限定で、低位株の理想帯を外れる銘柄は
  // Tier A/Bどちらでも候補自体から外す（他セクションには影響しない）。
  const inPriceBand = (r) => passesPriceBand(r.price, r.hasCatalyst, r.tenbaggerSource === 'us', r.diamond?.level === 'good');
  const tenbaggersA = [
    ...(smart.tenbaggerCandidatesA ?? []).map((r) => ({ ...r, tenbaggerSource: 'jp' })),
    ...(usTenbagger.results ?? []).filter((r) => r.tier === 'A').map((r) => ({ ...r, tenbaggerSource: 'us' })),
  ].filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  const tenbaggersB = [
    ...(smart.tenbaggerCandidatesB ?? []).map((r) => ({ ...r, tenbaggerSource: 'jp' })),
    ...(usTenbagger.results ?? []).filter((r) => r.tier === 'B').map((r) => ({ ...r, tenbaggerSource: 'us' })),
  ].filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  // A指示 項目13「米国テンバガーTierを3段階にする」: Tier C（$10B〜$20B
  // 程度・大型化後の超成長株）はJP側には存在しない（米国株のみ）ため
  // us_tenbagger.mjsの結果のみをフィルタする。
  const tenbaggersC = (usTenbagger.results ?? []).filter((r) => r.tier === 'C').map((r) => ({ ...r, tenbaggerSource: 'us' }))
    .filter(inPriceBand).sort(byTenbaggerRank).slice(0, RANK_TOP_N);
  const tenbaggerCandidates = [...tenbaggersA, ...tenbaggersB, ...tenbaggersC];

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
  smart.results.sort((a, b) => {
    const va = smartEntryVerdict(a, overheatSignal(a.kairi), growthSurgeSignal(a.market, a.closes));
    const vb = smartEntryVerdict(b, overheatSignal(b.kairi), growthSurgeSignal(b.market, b.closes));
    return (VERDICT_SEVERITY[va.level] - VERDICT_SEVERITY[vb.level])
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
<title>STEALTH v7.3 AMBUSH + SMART ENTRY</title>
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

  /* ── 初心者ガイド ── */
  .guide{border:1px solid var(--line);border-radius:13px;
         background:linear-gradient(180deg,rgba(20,29,46,.8),rgba(11,17,29,.62));
         backdrop-filter:blur(9px);margin-bottom:26px;padding:0 20px}
  .guide summary{list-style:none;cursor:pointer;padding:14px 0;
                 font:600 13px/1 var(--mono);color:var(--cyan);letter-spacing:.06em;
                 display:flex;align-items:center;gap:8px;user-select:none}
  .guide summary::-webkit-details-marker{display:none}
  .guide summary::after{content:"▾";margin-left:auto;color:var(--dim);transition:transform .2s}
  .guide[open] summary::after{transform:rotate(180deg)}
  .guide-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
              gap:22px;padding-bottom:18px;border-top:1px solid var(--line);padding-top:16px}
  .guide-h{font:700 11px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:10px}
  .guide-list{list-style:none;display:flex;flex-direction:column;gap:9px}
  .guide-list li{font:400 12.5px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
                 color:var(--dim)}
  .guide-list li b{color:var(--txt);font-weight:600}
  .guide-list .chip{margin-right:6px;pointer-events:none}
  @media(max-width:520px){
    .guide{padding:0 15px}
    .guide-body{grid-template-columns:1fr;gap:16px}
  }

  /* ── セクション（<details>化して折りたたみ可能に） ── */
  .sec{margin-bottom:34px}
  .sec-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:15px;
            padding-bottom:11px;border-bottom:1px solid var(--line);
            cursor:pointer;list-style:none}
  .sec-head::-webkit-details-marker{display:none}
  .sec-head h2{font-size:17px;font-weight:600;letter-spacing:.13em;display:flex;align-items:center;gap:9px}
  .ico{font-size:17px}
  /* ユーザー要望「セクションをカテゴリの右上に書いて。ワク作って」:
     SECTION A/B/Cは内部コード用語でUI上に一切表示されておらず、
     ユーザーが見つけられなかった（前回のやり取り参照）。見出しの右上
     （h2の直後・pより前）に枠付きバッジとして明示する。margin-left:auto
     で右へ寄せ、pにflex-basis:100%を付けて必ず次の行へ折り返させる
     ことで、既存の▾開閉アイコン（同じflexコンテナのafter擬似要素で
     margin-left:autoを使っている）と衝突せず両立させる。 */
  .sec-badge{margin-left:auto;font:600 11px/1 var(--mono);letter-spacing:.08em;color:var(--dim);
             border:1px solid var(--line);border-radius:5px;padding:4px 9px;white-space:nowrap;flex-shrink:0}
  .sec-head p{font:400 12px/1.6 var(--mono);color:var(--dim);letter-spacing:.06em;flex-basis:100%}
  .sec-head::after{content:"▾";margin-left:auto;color:var(--dim);transition:transform .2s;flex-shrink:0}
  .sec:not([open]) .sec-head{margin-bottom:0;border-bottom:none}
  .sec:not([open]) .sec-head::after{transform:rotate(-90deg)}
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
  .score-col{display:flex;flex-direction:column;align-items:center;gap:2px}
  .conviction-note{font:700 10px/1 var(--mono);color:var(--mint);letter-spacing:.04em;cursor:default}
  .conviction-note.neg{color:var(--rose)}

  /* ── SMART ENTRYの総合スコア（AMBUSHのリング型scoreGaugeとは
     スケールが違うため、シンプルな数値表示にしている） ── */
  .smart-score{flex:none;text-align:right;cursor:default}
  .smart-score-v{display:block;font:600 19.5px/1 var(--mono);color:var(--cyan)}
  .smart-score-u{font:500 8px/1 var(--mono);color:var(--dim);letter-spacing:.16em}

  /* ── ステータスランプ（買い推奨/様子見/見送り） ── */
  .score-trio{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
  .score-trio i{font-style:normal;color:var(--dim);font-size:11px}
  .reason-block{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--line)}
  .reason-group{margin-bottom:4px}
  .reason-group:last-child{margin-bottom:0}
  .reason-title{font:700 11px/1.4 var(--mono);color:var(--dim);letter-spacing:.03em}
  .reason-group ul{margin:2px 0 0;padding-left:18px;font:500 11.5px/1.5 var(--mono);color:var(--txt)}
  .exit-plan{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(77,159,255,.06);border:1px solid rgba(77,159,255,.25)}
  .exit-plan-h{font:700 11px/1.4 var(--mono);color:var(--blue);letter-spacing:.03em}
  .exit-plan-deadline{margin-top:2px;font:600 11.5px/1.4 var(--mono);color:var(--txt)}
  .exit-plan ul{margin:4px 0 0;padding-left:18px;font:500 11px/1.5 var(--mono);color:var(--dim)}
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
  .v-strong_buy{border-color:rgba(34,255,196,.5);background:rgba(34,255,196,.1)}
  .v-strong_buy .verdict-lamp{background:var(--mint);box-shadow:0 0 8px var(--mint)}
  .v-strong_buy .verdict-label{color:var(--mint)}
  .v-priced_in_caution{border-color:rgba(255,140,61,.4);background:rgba(255,140,61,.08)}
  .v-priced_in_caution .verdict-lamp{background:#ff8c3d;box-shadow:0 0 8px #ff8c3d}
  .v-priced_in_caution .verdict-label{color:#ff8c3d}

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

  /* ── 同業他社比較（AMBUSHのみ） ── */
  .peerbox{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
           background:rgba(9,14,24,.72)}
  .peerbox-head{font:700 10px/1 var(--mono);color:var(--dim);letter-spacing:.1em;margin-bottom:7px}
  .peerbox-sub{color:var(--txt);font-weight:700;margin-left:4px}
  .peer-table{width:100%;border-collapse:collapse;font:500 11px/1.6 var(--mono)}
  .peer-table th{color:var(--dim);font-weight:500;text-align:right;letter-spacing:.06em;font-size:9.5px}
  .peer-table th:first-child,.peer-table td:first-child{text-align:left;color:var(--dim)}
  .peer-table td{text-align:right;color:var(--txt)}
  .peerbox-note{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);
                font:500 10.5px/1.5 var(--mono);color:var(--amber);letter-spacing:.01em}

  /* ── いつまでに仕込むべきかの目安（AMBUSH専用） ── */
  .timing-note{margin-top:8px;padding:7px 12px;border:1px solid rgba(49,224,255,.25);
               border-radius:9px;background:rgba(49,224,255,.05);
               font:500 11px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}

  /* ── カタリスト予兆セクション ── */
  .precursor-card{border-color:rgba(124,77,255,.4)}
  .precursor-list{margin-top:13px;display:flex;flex-direction:column;gap:9px}
  .precursor-item{padding:9px 12px;border:1px solid rgba(124,77,255,.3);border-radius:9px;
                  background:rgba(124,77,255,.07)}
  .precursor-item-head{font:700 11.5px/1 var(--mono);color:#b39cff;letter-spacing:.04em;margin-bottom:6px}
  .precursor-item-note{font:500 11px/1.6 var(--mono);color:var(--dim);letter-spacing:.01em}
  .precursor-item.precursor-caution{background:rgba(255,180,61,.08);border-color:rgba(255,180,61,.35)}
  .precursor-item.precursor-caution .precursor-item-head{color:var(--amber)}
  .precursor-item.precursor-caution.is-bad{background:rgba(255,61,113,.08);border-color:rgba(255,61,113,.35)}
  .precursor-item.precursor-caution.is-bad .precursor-item-head{color:var(--rose)}
  /* 需給ワンポイントバッジ */
  .precursor-supply-badge{flex-shrink:0;padding:4px 9px;border-radius:7px;border:1px solid;
                           font:700 10.5px/1 var(--mono);letter-spacing:.02em;white-space:nowrap}
  .precursor-supply-badge.is-good{color:var(--mint);border-color:rgba(61,255,166,.4);background:rgba(61,255,166,.08)}
  .precursor-supply-badge.is-bad{color:var(--rose);border-color:rgba(255,61,113,.4);background:rgba(255,61,113,.08)}
  .precursor-supply-badge.is-mid{color:var(--amber);border-color:rgba(255,180,61,.4);background:rgba(255,180,61,.08)}
  /* 利益の質チェック（売掛金急増）でカード全体の枠を色付け */
  .precursor-card.flag-warn{border-color:rgba(255,180,61,.6)}
  .precursor-card.flag-bad{border-color:rgba(255,61,113,.65)}

  .divtrend{margin-top:8px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;
            background:rgba(9,14,24,.72);display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;
            font:500 11px/1.5 var(--mono)}
  .divtrend-head{color:var(--dim);letter-spacing:.06em;font-size:9.5px}
  .divtrend-row{color:var(--txt)}
  .divtrend-note{color:var(--mint);font-weight:700}

  /* ── コンセンサス非公開銘柄の代わりの根拠（ホバー任せにせず常時表示） ── */
  .altbox{margin-top:13px;padding:9px 12px;border:1px solid rgba(34,255,196,.3);border-radius:9px;
          background:rgba(34,255,196,.05)}
  .altbox-head{font:700 10px/1 var(--mono);color:var(--mint);letter-spacing:.08em;margin-bottom:7px}
  .altbox-list{list-style:none;display:flex;flex-direction:column;gap:6px}
  .altbox-list li{font:500 11px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}
  .altbox-list li b{color:var(--txt);font-weight:700}

  /* ── 仕込み妙味スコア（Repricing Lag） ── */
  .repricing{margin-top:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
             background:rgba(9,14,24,.72)}
  .repricing-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  .repricing-score{font:700 10.5px/1 var(--mono);color:var(--dim);letter-spacing:.04em}
  .repricing-fields{list-style:none;display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
  .repricing-fields li{font:500 10.5px/1.5 var(--mono);color:var(--dim);letter-spacing:.01em}
  .repricing-why{font:500 11px/1.6 var(--mono);color:var(--txt);letter-spacing:.01em}
  .repricing-caveat{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);
                     font:500 10px/1.5 var(--mono);color:var(--amber);letter-spacing:.01em}

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
  /* v7.5改修: テーマ性×小型×高成長×未織り込みが揃った希少な組み合わせ
     （diamondSignal）。通常のmint/amberチップと見分けやすいよう、
     グラデーション+わずかな光彩を付ける。 */
  .diamond{color:#fff;border-color:rgba(180,210,255,.6);
           background:linear-gradient(135deg,#7dd3fc,#a78bfa,#f472b6);
           box-shadow:0 0 8px rgba(167,139,250,.45);font-weight:700}

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
        <h1>STEALTH <b>v7.3</b> AMBUSH + SMART ENTRY</h1>
        <div class="sub">SBI EARNINGS CALENDAR × TDNET × KABUTAN</div>
      </div>
    </div>
    <div class="live"><span class="dot"></span>LIVE · ${live.length + smartLive.length} SYMBOLS LIVE / ${amb.results.length + smart.results.length} SCREENED</div>
  </div>

  <div class="hud">
    ${readout('NIKKEI 225', macro.nikkei?.toLocaleString() ?? '--', ' 円')}
    ${readout('USD / JPY', fmt(macro.usdjpy), '', caution ? 'down' : '')}
    <!-- 実測バグ: 米国株AMBUSHで「該当48/126」とHUDに出ていたのに、
         セクション本文はRANK_TOP_N(10)件しかカードを出しておらず、
         48件見つかると期待してクリックすると10件しか無い、という
         見出し件数とカード枚数の不一致があった（テンバガー候補の
         Tier小見出しで見つかった同種バグと同じ原因）。AMBUSH NOW・
         SMART ENTRY・米国株AMBUSHのHUDは、Math.min(実件数, RANK_TOP_N)
         でカード枚数の上限と揃える（AMBUSH WATCH/テンバガー候補は
         既にconst定義時点でスライス済みなので対応不要）。 -->
    ${readout('AMBUSH NOW', String(Math.min(now.length, RANK_TOP_N)), ' 件', now.length ? 'up' : '')}
    ${readout('AMBUSH WATCH', String(later.length), ' 件')}
    <a href="#q" style="text-decoration:none;color:inherit" title="PRE-AMBUSHセクションへジャンプ">${readout('PRE-AMBUSH', String(pre.length), ' 件')}</a>
    ${readout('SMART ENTRY', `${Math.min(smart.matched, RANK_TOP_N)}/${smart.universe}`, ' 該当', smart.matched ? 'up' : '')}
    <a href="#u" style="text-decoration:none;color:inherit" title="米国株AMBUSHセクションへジャンプ">${readout('🇺🇸 米国株', `${Math.min(us.results?.length ?? 0, RANK_TOP_N)}/${us.universe ?? 0}`, ' 該当', us.results?.length ? 'up' : '')}</a>
    <a href="#t" style="text-decoration:none;color:inherit" title="テンバガー候補セクションへジャンプ">${readout('💎 テンバガー', String(tenbaggerCandidates.length), ' 候補', tenbaggerCandidates.length ? 'up' : '')}</a>
    ${readout('先行材料あり', String(amb.results.filter((r) => r.evidence).length), ' 件')}
    ${readout('UNIVERSE', `${amb.passed}/${amb.universe}`, ' 通過')}
    ${readout('LAST SYNC', new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }), ' JST')}
  </div>

  ${beginnerGuide()}

  ${section('a', '🔥', 'AMBUSH NOW',
    `決算まで${WINDOW.nowMin}〜${WINDOW.nowMax}日 · 取引所確定日 · 先行カタリストあり · SCORE 70以上 · 未織込条件クリア · 上位${RANK_TOP_N}件`,
    now.slice(0, RANK_TOP_N).map((r, i) => card(r, i, { stale: !r.live })).join(''),
    `該当なし。ユニバース${amb.universe}銘柄中 Stage 1 通過は${amb.passed}銘柄でしたが、TDnetに先行カタリスト（好材料の開示・月次KPI）を持つ確定日銘柄はありませんでした。SECTION C に監視候補を出しています。`, 'A')}

  ${section('b', '🎯', 'SMART ENTRY',
    `決算スケジュールは見ず、需給と乖離だけで機械的にスクリーニングした「仕込み時」の銘柄。固定の登録銘柄ではなく、条件に合う銘柄がその日ごとに入れ替わります。低位株・薄商い・赤字/債務超過は全セクション共通で除外済み。底打ちを裏付ける根拠（出来高急増・解散価値割れ・配当下限・空売り膨張・業種の出遅れ）が見つかった銘柄にはチップを表示し、結論（買い推奨→様子見→見送り）を最優先の基準に、同じ結論内ではSCORE（乖離の深さだけでなく裏付け・警告も加味した総合点）が高い順に並べています。SCOREが高くても結論が「様子見/見送り」の銘柄は、SCOREの低い「買い推奨」より下に来ます。上位${RANK_TOP_N}件のみ表示します。`,
    smart.results.slice(0, RANK_TOP_N).map((r, i) => smartEntryCard(r, i)).join(''),
    `該当なし。ユニバース${smart.universe}銘柄をスキャンしましたが、3つの仕込みパターンのいずれにも合致する銘柄がありませんでした。`, 'B')}

  <details class="sec" id="c" open>
    <summary class="sec-head">
      <h2><span class="ico">👀</span>AMBUSH WATCH</h2>
      ${sectionBadge('C')}
      <p>Stage 1 通過 ${amb.passed}銘柄のうち NOW 条件を満たさなかったもの（決算まで${WINDOW.watchMin}〜${WINDOW.watchMax}日）· 上位${AMBUSH_WATCH_MAX}件 · 先行カタリストの有無で「仕込み候補」「参考」に分け、各グループ内は結論（買い推奨→様子見→見送り）を最優先に、同じ結論内では素点SCORE＋底打ち確認/同業他社比較の裏付け加点（カード内「+○pt」）の合計が高い順に並べています。「参考」グループはこの合計が高くても先行カタリストが無いため上のグループより下に表示されます</p>
    </summary>
    ${!later.length ? `<div class="empty">Stage 1 を通過した銘柄はありません。</div>` : `
    ${laterEvidence.length ? `
    <div class="subhead sub-good">🟢 仕込み候補 — 先行カタリストの根拠あり（${laterEvidence.length}件）</div>
    <div class="grid">${laterEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    ${laterNoEvidence.length ? `
    <div class="subhead sub-ref">⚪ 参考 — 先行材料なし・スコアは目安程度（${laterNoEvidence.length}件）</div>
    <div class="grid">${laterNoEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    `}
  </details>

  ${section('p', '🔮', 'カタリスト予兆',
    `「材料が出てから買う」のではなく「材料が出るしかない財務状況」を先回りして拾うセクションです。決算の開示（TDnetの好材料・月次KPI）がまだ無くても、財務データから客観的に読み取れる好材料の予兆（進捗率の連続上振れ・株主還元ポテンシャル・含み資産）に加え、粉飾や見た目ほど強気ではない兆候を先取りする注意予兆（⚠️売掛金の急増・進捗率加速も減益）も表示します。カード右上の需給バッジ（信用買い占有率）は「材料が出た場合に伸びやすいか」を示す補助情報で、これ単体では掲載基準にしていません（実測で需給が軽いだけの銘柄が大半を占めてしまったため分離）。対象はAMBUSHユニバース（決算まで7〜60日の銘柄）と、東証グロース市場銘柄全体（出来高・時価総額で絞り込み）の2つです。「成長株（東証グロース）」チップの付いたカードは決算スケジュールとは無関係の予兆で、AMBUSHの候補ではありません。予兆はあくまで確率的な手がかりであり、確定した好材料・悪材料ではない点にご注意ください。該当予兆の種類が多い順に上位${RANK_TOP_N}件のみ表示します。`,
    precursors.slice(0, RANK_TOP_N).map((r, i) => precursorCard(r, i)).join(''),
    `該当なし。AMBUSHユニバース${amb.universe}銘柄・東証グロース市場銘柄中、進捗率の連続上振れ・株主還元ポテンシャル・含み資産・売掛金急増のいずれかに該当する銘柄はありませんでした。`)}

  <details class="sec" id="q" open>
    <summary class="sec-head">
      <h2><span class="ico">🔵</span>PRE-AMBUSH</h2>
      <p>決算まで${WINDOW.preMin}〜${WINDOW.preMax}日の早期監視枠（v7.3新設）· 上位${AMBUSH_WATCH_MAX}件 · AMBUSH WATCH/NOWと同じ判定基準を先行して適用しているだけで、判定ロジック自体は共通です。今後カタリストが発生しWATCH・NOWに「昇格」する可能性がある銘柄を早期に把握するための枠です</p>
    </summary>
    ${!pre.length ? `<div class="empty">決算まで${WINDOW.preMin}〜${WINDOW.preMax}日の銘柄はありません。</div>` : `
    ${preEvidence.length ? `
    <div class="subhead sub-good">🟢 仕込み候補 — 先行カタリストの根拠あり（${preEvidence.length}件）</div>
    <div class="grid">${preEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    ${preNoEvidence.length ? `
    <div class="subhead sub-ref">⚪ 参考 — 先行材料なし・スコアは目安程度（${preNoEvidence.length}件）</div>
    <div class="grid">${preNoEvidence.map((r, i) => card(r, i, { stale: !r.live })).join('')}</div>` : ''}
    `}
  </details>

  ${section('u', '🇺🇸', '米国株 AMBUSH（Phase 1）',
    `Finnhub決算カレンダーで決算まで${US_WINDOW.nowMin}〜${US_WINDOW.preMax}日の米国企業に絞り込み（全米市場対象・銘柄を限定していません）、Yahoo Financeの日足で乖離率・RSI・出来高Zの技術的な足切り、SEC EDGARの財務データで解散価値割れ・四半期実績の前年同期比トレンドを判定しています。日本株AMBUSHと異なり、TDnet相当の先行カタリスト検出・セクターモメンタム・期待値のワナ（会社予想とコンセンサスの比較）には対応していません（米国には公式な通期業績予想の開示制度が無いため）。無料プランのFinnhubは確定日と見込み日を区別せずに返すため、アナリスト網羅度の低い小型株ほど決算日・あと○日の表示精度が落ちる点にご注意ください。1日1回（日本時間早朝）更新・SCORE上位${RANK_TOP_N}件のみ表示します。`,
    (us.results ?? []).slice(0, RANK_TOP_N).map((r, i) => usCard(r, i)).join(''),
    us.degraded
      ? 'Finnhub決算カレンダーが取得できませんでした（FINNHUB_API_KEY未設定または取得失敗）。'
      : `該当なし。ユニバース${us.universe ?? 0}銘柄をスキャンしましたが、条件に合う銘柄がありませんでした。`)}

  <details class="sec" id="t" open>
    <summary class="sec-head">
      <h2><span class="ico">💎</span>テンバガー候補</h2>
      <p>決算日に依存しない、日本株・米国株共通のテーマ性成長株セクションです（AMBUSHとは分離）。<b>Tier A</b>＝時価総額300億円/$1B以下・本来のテンバガー(10倍)候補。<b>Tier B</b>＝300億〜1000億円/$1B〜$10Bの、10倍は非現実的だが2〜3倍は狙えるグロース中堅株（いずれも売上高成長率+25%以上）。株価が100〜700円(日本)/$1〜$7(米国)の理想帯を外れ先行材料も乏しい銘柄は候補から除外し、仕込みゾーンが🔴織り込み済みの銘柄は除外はせず各Tier内で下位に回します。TAM・受注/RPO等は無料データソースが無く未対応、値動きは荒い点にご注意ください。各Tier上位${RANK_TOP_N}件のみ表示します。</p>
    </summary>
    ${!tenbaggerCandidates.length ? `<div class="empty">該当なし。日本株（東証グロース市場銘柄）・米国株（キュレーションリスト）とも、Tier A/B/C（Tier Cは米国株のみ）いずれの条件にも合う銘柄が無いか、株価帯フィルター（100〜700円/$1〜$7、材料十分なら1500円/$15まで許容）で除外されました。</div>` : `
    ${tenbaggersA.length ? `
    <div class="subhead sub-good">🚀 Tier A — 低時価総額テンバガー候補（${tenbaggersA.length}件）</div>
    <div class="grid">${tenbaggersA.map((r, i) => tenbaggerCard(r, i)).join('')}</div>` : ''}
    ${tenbaggersB.length ? `
    <div class="subhead sub-ref">🌱 Tier B — 中型成長株候補（2〜3倍目安、${tenbaggersB.length}件）</div>
    <div class="grid">${tenbaggersB.map((r, i) => tenbaggerCard(r, i)).join('')}</div>` : ''}
    `}
  </details>

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
// 初心者ガイドの開閉状態を覚えておく。60秒ごとの自動リロードのたびに
// サーバー側では常にopen属性付きで生成しているため、これが無いと
// 一度読んで畳んだユーザーでも1分後に強制的に再展開されてしまう。
(function () {
  var KEY = 'ambush.guideOpen';
  var el = document.querySelector('.guide');
  if (!el) return;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved === '0') el.removeAttribute('open');
  } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
  el.addEventListener('toggle', function () {
    try { sessionStorage.setItem(KEY, el.open ? '1' : '0'); } catch (e) { }
  });
})();

// セクション（AMBUSH NOW・カタリスト予兆・SMART ENTRY等）ごとの折りたたみ
// 開閉状態を覚えておく（ユーザー要望）。.guideと同じ理由（60秒ごとの
// 自動リロードでサーバー側は常にopen属性付きで生成するため、これが無いと
// 畳んでもすぐ再展開されてしまう）でsessionStorageに保存する。
// セクションはidで区別する（section()呼び出し時に渡している既存のid、
// 例: 'p'=カタリスト予兆, 'a'=AMBUSH NOW 等）。
(function () {
  var PREFIX = 'ambush.sectionOpen.';
  document.querySelectorAll('details.sec[id]').forEach(function (el) {
    var key = PREFIX + el.id;
    try {
      var saved = sessionStorage.getItem(key);
      if (saved === '0') el.removeAttribute('open');
    } catch (e) { /* file:// で sessionStorage が使えない環境では諦める */ }
    el.addEventListener('toggle', function () {
      try { sessionStorage.setItem(key, el.open ? '1' : '0'); } catch (e) { }
    });
  });
})();

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

  auditGeneratedHtml(html);
  fs.writeFileSync(OUT_FILE, html);
  publishToICloud(html);
  if (!NO_OPEN) exec(`open ${JSON.stringify(OUT_FILE)}`);
  console.log(
    `✅ 完了 / SMART ENTRY ${smart.results.length}件 · AMBUSH NOW ${now.length}件 · WATCH ${later.length}件 / ${((Date.now() - t0) / 1000).toFixed(1)}秒`
  );
  // 実測: 手動で起動した--forceの長時間実行中にMacがスリープ/バッテリー
  //切れになり、約36時間中断された後に実行が再開・完了した事例が発生した
  // （ロック機構は「プロセスが生きているか」だけを見る設計なので、
  // スリープ中もロックは正しく保持され続け、二重実行は防げていたが、
  // その間キャッシュが更新されず順位が2日以上古いまま配信され続けた）。
  // todayはmain()の先頭で1度だけ捕捉した値なので、実行が日をまたいで
  // 中断された場合はキャッシュのdateフィールドが開始日のまま古くなる。
  // ログを見ただけで異常に気付けるよう、実行時間が2時間を超えた場合は
  // 明示的に警告する（原因調査に日をまたいだログの突き合わせが必要
  // だった反省）。
  const elapsedHours = (Date.now() - t0) / 3600000;
  if (elapsedHours > 2) {
    console.error(`  ⚠️ 実行に${elapsedHours.toFixed(1)}時間かかりました（通常は1時間未満）。途中でスリープ/バッテリー切れが無かったか確認してください。todayは開始時点の${today}のまま記録されています`);
  }
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

// `node scraper.mjs` として直接実行された時だけmain()を走らせる。
// テストからbuyRuleChecklist等をimportする際に、スクレイピング本体まで
// 副作用として動いてしまわないようにするためのガード。
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ 異常終了: ${e.stack ?? e.message}`);
    releaseLock();
    process.exit(1);
  });
}
