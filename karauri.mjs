// ==================================================================
// karauri.mjs — karauri.net（空売りネット）から機関投資家の空売り残高を取得
//
//  ■ データの性質（既存のkabutan信用残データとの違い）
//  kabutan.mjsのfetchWeeklyCredit（信用売り残）は「信用取引」＝主に個人
//  投資家の空売りだが、karauri.netは大量保有報告規則（残高割合0.5%超）に
//  基づき機関投資家（ヘッジファンド等）が法定開示した空売りポジションの
//  推移。同じ「空売り」でも投資主体が異なる別データであり、重複しない。
//
//  ■ robots.txt
//  User-agent:*にAllow（SEOクローラーのみ個別Disallow、AI系ボットの
//  名指し拒否なし）。
//
//  ■ ページ構造
//  /{code}/ に「機関の空売り残高情報」テーブルが1つ、JS実行不要の
//  サーバー生成HTMLとして載っている。1行＝1機関・1回の開示イベント
//  （新規開示・増減・報告義務消失のいずれか）。同じ機関が複数回出現し、
//  日付降順で並ぶ。機関のIDはリンクの?f=NNNクエリで一意に識別できる。
//  「報告義務消失」の行がその機関の最新行なら、以後は非開示水準（0.5%
//  未満）まで減ったことを意味する＝現在の空売り残高には含めない。
// ==================================================================
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
export const REQ_GAP = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    }
  }
}

// 機関ごとの開示履歴（日付降順）から、指定日時点で有効な残高割合の合計を返す。
// cutoff=nullなら「最新」＝各機関の先頭行（日付降順なので0番目）を使う。
function totalPctAsOf(byId, cutoff) {
  let total = 0;
  for (const rows of byId.values()) {
    const asOf = cutoff === null ? rows[0] : rows.find((r) => r.date <= cutoff);
    if (asOf && !asOf.lapsed) total += asOf.pct;
  }
  return Math.round(total * 1000) / 1000;
}

const EMPTY_SHORT_INTEREST = { totalPct: null, asOfDate: null, changePct: null, checked: false };

// HTML文字列から機関投資家の空売り残高（合計%）とlookbackDays日前からの
// 増減を計算する（ネットワークを使わない純粋関数。テスト容易性のため
// fetchInstitutionalShortInterestから分離）。
export function parseInstitutionalShortInterest(html, lookbackDays = 90) {
  const tableMatch = html.match(/<table id="sort"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) return EMPTY_SHORT_INTEREST; // 空売り開示が1件も無い銘柄（テーブル自体が無い）

  const trRows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const dataRows = trRows.filter((r) => r.includes('<td')); // <th>だけの見出し行を除く

  const parsed = [];
  for (const r of dataRows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 7) continue;
    // 計算日セルは銘柄によって素のテキストの場合と<a>タグで囲まれている
    // 場合がある（実測: 7921は素のテキスト、3038はリンク付き）ため、
    // セル内容をそのまま日付文字列として使わず、日付パターンで抽出する。
    const dateMatch = cells[0].match(/(\d{4})\/(\d{2})\/(\d{2})/);
    const idMatch = cells[1].match(/\?f=(\d+)/);
    const pctMatch = cells[2].match(/([\d.]+)%/);
    if (!dateMatch || !idMatch || !pctMatch) continue;
    parsed.push({
      date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`, // "YYYY-MM-DD"で文字列比較を安全にする
      id: idMatch[1],
      pct: parseFloat(pctMatch[1]),
      lapsed: cells[6].includes('報告義務消失'),
    });
  }
  if (!parsed.length) return EMPTY_SHORT_INTEREST;

  parsed.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい日付が先頭
  const byId = new Map();
  for (const p of parsed) {
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }

  const asOfDate = parsed[0].date;
  const totalPct = totalPctAsOf(byId, null);
  const cutoffDate = new Date(new Date(asOfDate).getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const pastPct = totalPctAsOf(byId, cutoffDate);
  const changePct = Math.round((totalPct - pastPct) * 1000) / 1000;

  return { totalPct, asOfDate, changePct, checked: true };
}

// 現在の機関投資家空売り残高（合計%）と、lookbackDays日前からの増減を返す。
// 増減がマイナス＝直近で機関の買い戻し（空売り解消）が進んでいることを示す。
export async function fetchInstitutionalShortInterest(code, lookbackDays = 90) {
  const html = await getText(`https://karauri.net/${code}/`);
  return parseInstitutionalShortInterest(html, lookbackDays);
}
