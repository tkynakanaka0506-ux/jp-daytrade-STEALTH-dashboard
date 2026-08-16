// ==================================================================
// tdnet.mjs — 適時開示（TDnet）取得とルールベース評価
//
//  LLM API は使わない（仕様書§25）。純粋な文字列ルール。
//
//  ■ キーワード表を実測で組み直した理由
//  仕様書のキーワード表を 2026/08/11〜14 の全開示 2,225件で検証したところ、
//  以下は 0件 だった:  増益 / 大型受注 / 特許 / 海外展開 / 自社株買い /
//                      下方修正 / 減益 / 減配 / 最高益 / 過去最高
//  企業が実際に使う表記は「自己株式取得」「資本業務提携」「特別損失計上」
//  「減損損失」などで、仕様書の語では拾えない。そこで実測に基づく語彙へ
//  差し替えた。意図（好材料/悪材料の判別）は仕様書のまま。
//
//  ■ 判別できないもの（推測で埋めない）
//  「業績予想の修正」70件のうち上方/下方が題名に明記されるのは10件のみ。
//  残り60件は題名だけでは方向不明なので、加点も減点もせず
//  needsReview フラグを立てて DATA CONFIDENCE を下げる。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'tdnet_cache.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const REQ_GAP = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------
// ルール表（重みは実測の希少性と株価インパクトから設定。要調整）
// ------------------------------------------------------------------
export const POSITIVE = [
  { kw: '上方修正', w: 30, label: '業績上方修正' },
  { kw: '受注', w: 20, label: '受注' },
  { kw: '増配', w: 18, label: '増配' },
  { kw: '資本業務提携', w: 16, label: '資本業務提携' },
  { kw: '自己株式取得', w: 15, label: '自社株買い' },
  { kw: '業務提携', w: 14, label: '業務提携' },
  { kw: '子会社化', w: 12, label: 'M&A' },
  { kw: '契約締結', w: 10, label: '契約締結' },
  { kw: '新製品', w: 10, label: '新製品' },
  { kw: '新工場', w: 10, label: '新工場' },
  { kw: '基本合意', w: 9, label: '基本合意' },
  { kw: '株式分割', w: 8, label: '株式分割' },
];

export const NEGATIVE = [
  { kw: '下方修正', w: -30, label: '業績下方修正' },
  { kw: '無配', w: -25, label: '無配' },
  { kw: '減損', w: -25, label: '減損' },
  { kw: '特別損失', w: -24, label: '特別損失' },
  { kw: '訴訟', w: -15, label: '訴訟' },
  { kw: '中止', w: -14, label: '中止' },
  { kw: '延期', w: -12, label: '延期' },
];

// 方向が題名から判別できないもの（加減点しない）
const AMBIGUOUS = ['業績予想の修正', '業績予想及び配当予想の修正', '配当予想の修正'];

// カタリストではないもの
//  補足資料/補足説明資料 と「（開示事項の経過）」は、既に開示済みの1件の
//  案件に付随する二次文書。本文と同じキーワードを含むため、除外しないと
//  同じ材料を2回3回と加点してしまう（実測: 9235は同一のM&Aで3件、
//  3070は同一の業務提携で2件が別々に加点されていた）。
const NOISE = /訂正|決算短信|有価証券報告書|臨時報告書|半期報告書|説明会資料|補足資料|補足説明資料|開示事項の経過|通知書|上場廃止に関する/;

// 月次KPI開示（先行指標の存在確認。中身の前年比は題名に出ないためN/A）
const MONTHLY = /月次|月度|売上高速報|受注速報/;

// ------------------------------------------------------------------
// 取得
// ------------------------------------------------------------------
async function getPage(dateCompact, p) {
  const url = `https://www.release.tdnet.info/inbs/I_list_${String(p).padStart(3, '0')}_${dateCompact}.html`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.text();
}

function parseRows(html) {
  const out = [];
  const re = /<td class="(?:odd|even)new-M kjCode"[^>]*>([^<]*)<\/td>\s*<td class="(?:odd|even)new-M kjName"[^>]*>([^<]*)<\/td>\s*<td class="(?:odd|even)new-M kjTitle"[^>]*>([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(re)) {
    // TDnetの銘柄コードは5桁（例 87980 = 8798 + 末尾0）
    out.push({ code: strip(m[1]).slice(0, 4), name: strip(m[2]), title: strip(m[3]) });
  }
  return out;
}

export async function fetchDay(dateCompact) {
  const first = await getPage(dateCompact, 1);
  const pages = [...first.matchAll(new RegExp(`I_list_(\\d+)_${dateCompact}`, 'g'))].map((m) => Number(m[1]));
  const max = pages.length ? Math.max(...pages) : 1;
  const rows = parseRows(first);
  for (let p = 2; p <= max; p++) {
    await sleep(REQ_GAP);
    try {
      rows.push(...parseRows(await getPage(dateCompact, p)));
    } catch (e) {
      console.error(`  ⚠️ TDnet ${dateCompact} p${p}: ${e.message}`);
    }
  }
  return rows;
}

// ------------------------------------------------------------------
// 直近 days 営業日分を取得して code をキーに索引化（日次キャッシュ）
// ------------------------------------------------------------------
export async function loadDisclosures({ today, days = 14, force = false } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.byCode) {
    console.log(`💾 TDnetキャッシュ有効 (${today}) — ${Object.keys(cache.byCode).length}銘柄 / リクエスト0件`);
    return cache;
  }

  const byCode = {};
  let fetched = 0, total = 0;
  const t = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i < days * 1.6 && fetched < days; i++) {
    const d = new Date(t.getTime() - i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 土日は開示なし
    const compact = d.toISOString().slice(0, 10).replace(/-/g, '');
    const iso = d.toISOString().slice(0, 10);
    try {
      const rows = await fetchDay(compact);
      fetched++;
      total += rows.length;
      for (const r of rows) (byCode[r.code] ??= []).push({ date: iso, title: r.title });
    } catch (e) {
      console.error(`  ⚠️ TDnet ${compact}: ${e.message}`);
    }
    await sleep(REQ_GAP);
  }

  const out = { date: today, days: fetched, total, byCode };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ TDnet: ${fetched}営業日 / ${total}件 / ${Object.keys(byCode).length}銘柄`);
  return out;
}

// ------------------------------------------------------------------
// 評価: 1銘柄ぶんの開示リスト → PR/TDnetスコア（0〜30）
//
//  生の合計をそのまま返さず 0〜30 に収める。
//  ネガティブが1つでもあれば強く引き下げる（AMBUSHは「良い触媒」が前提）。
// ------------------------------------------------------------------
export function evaluate(disclosures = []) {
  const hits = [], negs = [], ambiguous = [];
  let monthly = false;
  let raw = 0;
  // 重みは「イベント1件あたり」で決めているので、同じ種類の材料は
  // 何件開示されても1回しか加点しない。NOISEで二次文書を落としても、
  // 同一案件が別表現で複数回開示されることがあるための保険。
  const scored = new Set();

  for (const d of disclosures) {
    if (NOISE.test(d.title)) continue;
    if (MONTHLY.test(d.title)) monthly = true;

    let matched = false;
    for (const r of NEGATIVE) {
      if (d.title.includes(r.kw)) {
        if (!scored.has(r.label)) { raw += r.w; scored.add(r.label); negs.push({ ...r, date: d.date, title: d.title }); }
        matched = true; break;
      }
    }
    if (matched) continue;
    for (const r of POSITIVE) {
      if (d.title.includes(r.kw)) {
        if (!scored.has(r.label)) { raw += r.w; scored.add(r.label); hits.push({ ...r, date: d.date, title: d.title }); }
        matched = true; break;
      }
    }
    if (matched) continue;
    // 方向不明の業績・配当予想修正は加減点せず、要確認として記録するだけ
    if (AMBIGUOUS.some((k) => d.title.includes(k))) ambiguous.push({ date: d.date, title: d.title });
  }

  const score = disclosures.length === 0 ? null : Math.max(0, Math.min(30, raw));
  return {
    score,                        // 0〜30。開示が1件も無ければ null（＝判定不能）
    raw,
    positives: hits,
    negatives: negs,
    ambiguous,                    // 方向不明。DATA CONFIDENCE を下げる材料
    hasMonthly: monthly,          // 月次KPIを開示している＝先行指標が存在する
    needsReview: ambiguous.length > 0,
  };
}
