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
//  「業績予想の修正」は題名に上方/下方が書かれないことが多い（実測 14営業日
//  8,290件で 671件中 上方明記29 / 下方明記0 / 方向不明642＝96%）。
//  方向不明は加点も減点もできないので needsReview フラグを立て、
//  screener.mjs の confidencePenalty() が DATA CONFIDENCE から控除する。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadHolidays, isMarketHoliday } from './holidays.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'tdnet_cache.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const REQ_GAP = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------
// ルール表（重みは実測の希少性と株価インパクトから設定。要調整）
// ------------------------------------------------------------------
// v7.3改修（ユーザー指示書 項目6）: カタリストをS/A/B/Cランクで強弱化。
// ■ 実測で分かったこと（重要）: ユーザー提案の追加キーワード（規制緩和・
// 大型案件・KPI急改善）を実際の開示タイトル2,604件（tdnet_cache.json）
// で検索したところ、いずれも0件だった。「認可」は1件ヒットしたが
// 「株式交換契約に係る定時株主総会の承認可決」という無関係な文字列への
// 誤マッチ（「認可」が「承認可決」の中に部分一致するだけ）で、実際の
// 認可・許認可のニュースではなかった。このファイル冒頭のコメントで
// 既に警告されている「仕様書のキーワードは実測すると0件になりがち」が
// 今回も再現したため、これらの新規キーワードは追加しない（推測で
// マッチさせない）。既存の実測済みキーワードの重みをS/A/B/Cに変換する
// ことで対応する。KPI関連の開示（実測5件、いずれも「月次」「月度」を
// 含む）は既存のMONTHLY正規表現で既にhasMonthly:trueとして捕捉できている。
export const POSITIVE = [
  { kw: '上方修正', w: 30, label: '業績上方修正', tier: 'S' },
  { kw: '受注', w: 20, label: '受注', tier: 'S' },
  { kw: '増配', w: 18, label: '増配', tier: 'S' },
  { kw: '資本業務提携', w: 16, label: '資本業務提携', tier: 'A' },
  { kw: '自己株式取得', w: 15, label: '自社株買い', tier: 'A' },
  { kw: '業務提携', w: 14, label: '業務提携', tier: 'A' },
  { kw: '子会社化', w: 12, label: 'M&A', tier: 'A' },
  { kw: '契約締結', w: 10, label: '契約締結', tier: 'A' },
  { kw: '新製品', w: 10, label: '新製品', tier: 'A' },
  { kw: '新工場', w: 10, label: '新工場', tier: 'A' },
  { kw: '基本合意', w: 9, label: '基本合意', tier: 'B' },
  { kw: '株式分割', w: 8, label: '株式分割', tier: 'B' },
];

export const NEGATIVE = [
  // 支配株主等による株式等売渡請求＝スクイーズアウトで強制的に上場廃止
  // になる決定。決算先読み（AMBUSH）の前提「決算カタリストで株価が動く」
  // 自体が成立しなくなる（買収価格に価格が固定され、以後の株価は決算に
  // 反応しなくなる）最重要の悪材料。以前はNOISE側の「上場廃止に関する」
  // に引っかかって無条件でスコアから除外されており、実測で3480ジェイ・
  // エス・ビー（2026-08-10にスクイーズアウト決定を開示）が様子見判定の
  // まま表示され、上場廃止リスクが一切反映されていなかった。
  { kw: '株式等売渡請求', w: -35, label: '上場廃止（スクイーズアウト）', severe: true },
  { kw: '下方修正', w: -30, label: '業績下方修正' },
  { kw: '無配', w: -25, label: '無配' },
  { kw: '減損', w: -25, label: '減損' },
  { kw: '特別損失', w: -24, label: '特別損失' },
  { kw: '訴訟', w: -15, label: '訴訟' },
  { kw: '中止', w: -14, label: '中止' },
  { kw: '延期', w: -12, label: '延期' },
  // v7.3改修 項目8: 減点ではなくハード除外にすべき「重大リスク」。実測
  // （tdnet_cache.json 全2,772件）で検証: 「継続企業疑義」は0件（EDINETの
  // 注記テキストにしか出ず、開示タイトルからは判別不能なため見送り）。
  // 「第三者割当」単体は90件あるが大半が「月間行使状況」「払込完了」等の
  // 定型フォローアップや、既存M&A・自社株買いの手続き文書で、これだけを
  // ハード除外条件にすると無関係な銘柄まで巻き込む（実測: 大半がノイズ）。
  // 一方「大量行使」「大量転換」は行使価額修正条項付ワラント/CBが実際に
  // 大量に権利行使・転換されている＝希薄化が今まさに進行中という曖昧さの
  // ない事実（実測12銘柄でヒット、いずれも真に希薄化イベント）なので、
  // これのみをハード除外の対象にする。「下方修正」は既存コメント
  // （ファイル冒頭）どおり実測0件＝タイトルからは方向判別不能なため、
  // ハード除外はできない（AMBIGUOUS経由のneedsReview/confidence減点に留める）。
  { kw: '大量行使', w: -20, label: '大規模希薄化（大量行使）', severe: true },
  { kw: '大量転換', w: -20, label: '大規模希薄化（大量転換）', severe: true },
];

// 方向が題名から判別できないもの（加減点しない）
const AMBIGUOUS = ['業績予想の修正', '業績予想及び配当予想の修正', '配当予想の修正'];

// カタリストではないもの
//  補足資料/補足説明資料 と「（開示事項の経過）」は、既に開示済みの1件の
//  案件に付随する二次文書。本文と同じキーワードを含むため、除外しないと
//  同じ材料を2回3回と加点してしまう（実測: 9235は同一のM&Aで3件、
//  3070は同一の業務提携で2件が別々に加点されていた）。
// 「上場廃止に関する」は以前ここに含めていたが、スクイーズアウト決定の
// ような最重要の悪材料までノイズとして無条件に握りつぶしてしまっていた
// （実測: 3480ジェイ・エス・ビー）。NEGATIVEキーワード側で拾うため除外。
const NOISE = /訂正|決算短信|有価証券報告書|臨時報告書|半期報告書|説明会資料|補足資料|補足説明資料|開示事項の経過|通知書/;

// 月次KPI開示（先行指標の存在確認。中身の前年比は題名に出ないためN/A）
const MONTHLY = /月次|月度|売上高速報|受注速報/;

// ------------------------------------------------------------------
// 取得
// ------------------------------------------------------------------
async function getPage(dateCompact, p) {
  const url = `https://www.release.tdnet.info/inbs/I_list_${String(p).padStart(3, '0')}_${dateCompact}.html`;
  // 他ファイルと同じ理由（Macのスリープ中にfetchが無期限に応答待ちになり
  // プロセス全体がハングする事象の再発防止）でタイムアウトを設ける。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
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

  // 祝日はTDnetにページ自体が存在せず404になる。土日だけ飛ばしていた頃は
  // 祝日のたびに1リクエスト無駄打ちしてエラーログを出していた（実測:
  // 2026-08-11 山の日）。営業日カウントも祝日ぶん足りなくなる。
  const { dates: holidays } = await loadHolidays();

  const byCode = {};
  // 銘柄名も拾っておく（スマート・エントリーの全銘柄ユニバース構築に使う。
  // 開示のたびに上書きするので、最新の開示に出た表記が残る）。
  const names = {};
  let fetched = 0, total = 0, skipped = 0;
  const t = new Date(`${today}T00:00:00Z`);
  // 休業日を飛ばすぶん、遡る日数の上限に余裕を持たせる（days*2.2）
  for (let i = 0; i < days * 2.2 && fetched < days; i++) {
    const d = new Date(t.getTime() - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    if (isMarketHoliday(iso, holidays)) { skipped++; continue; } // 土日・祝日・年末年始
    const compact = iso.replace(/-/g, '');
    try {
      const rows = await fetchDay(compact);
      fetched++;
      total += rows.length;
      for (const r of rows) {
        (byCode[r.code] ??= []).push({ date: iso, title: r.title });
        if (r.name) names[r.code] = r.name;
      }
    } catch (e) {
      console.error(`  ⚠️ TDnet ${compact}: ${e.message}`);
    }
    await sleep(REQ_GAP);
  }

  const out = { date: today, days: fetched, total, byCode, names };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ TDnet: ${fetched}営業日 / ${total}件 / ${Object.keys(byCode).length}銘柄（休業日${skipped}日スキップ）`);
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
  // v7.3改修 項目6: 「先行材料あり/なし」の2値から、S/A/B/Cランクへ強弱化。
  // hitsは開示の処理順（時系列）に積まれるだけで重み順ではないため、
  // 複数の好材料がある場合は最も強いtierを採用する（TIER_RANK参照）。
  // 好材料が無くても方向不明の業績予想修正（ambiguous）があれば、判定
  // できないなりに一応の材料はあるという意味でCランク（弱い材料）とする。
  const TIER_RANK = { S: 0, A: 1, B: 2, C: 3 };
  const tier = hits.length
    ? hits.map((h) => h.tier).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0]
    : ambiguous.length ? 'C' : null;
  // v7.3改修 項目8: severe:trueが付いた悪材料（上場廃止決定・大規模希薄化の
  // 進行）は、様子見/見送りに判定を落とすだけでなく候補一覧から丸ごと
  // ハード除外する（呼び出し側screener.mjsで results.push 前にスキップ）。
  const severeRiskHits = negs.filter((n) => n.severe);

  return {
    score,                        // 0〜30。開示が1件も無ければ null（＝判定不能）
    raw,
    tier,                         // S/A/B/C。開示・材料が無ければnull
    score100: score === null ? null : Math.round((score / 30) * 100), // 表示用の100点換算
    positives: hits,
    negatives: negs,
    severeRiskHits,               // 空配列＝重大リスク無し
    ambiguous,                    // 方向不明。DATA CONFIDENCE を下げる材料
    hasMonthly: monthly,          // 月次KPIを開示している＝先行指標が存在する
    needsReview: ambiguous.length > 0,
  };
}
