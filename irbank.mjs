// ==================================================================
// irbank.mjs — IR Bank（irbank.net）から売上債権（売掛金＋受取手形）を取得
//
//  ネットネット判定 (現預金＋売掛金×0.75)－負債総額 の「売掛金」ぶんが
//  kabutanには存在しないため、ユーザー紹介のIR Bankから補う。
//  robots.txtはUser-agent:*にAllow:/（AIクローラー個別ブロックなし）。
//  Buffett Codeはrobots.txtでClaudeBot/anthropic-ai等を名指しでDisallow
//  しているため、そちらは使わない。
//
//  ■ データの所在
//  各銘柄の貸借対照表チャートは /{code}/bs にGoogle Charts用の配列
//  リテラルとして埋め込まれている（JS実行不要、テキストとして取得可能）。
//  例: gGm([["year","投資等",...,"売上債権","現金等","たな卸資産"],
//           ["2026年4月",{v:34891000000,f:"..."},...]],"debit",...)
//  eval/Functionは使わず、正規表現と手動のブラケット深さ走査だけで
//  安全にパースする（外部サイトの埋め込みJSをそのまま実行しない）。
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

// "[" "]" の深さだけを見て、最上位（深さ0）の [...] 要素を1つずつ切り出す。
// オブジェクトリテラル {...} は [ ] を含まないため干渉しない。
function splitTopLevelArrays(s) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === ']') { depth--; if (depth === 0) out.push(s.slice(start, i + 1)); }
  }
  return out;
}

// ["2026年4月",{v:123,f:"..."},0,...] → { date:"2026年4月", vals:[123,0,...] }
function parseRow(rowStr) {
  const inner = rowStr.slice(1, -1);
  const dateMatch = inner.match(/^"([^"]+)"/);
  if (!dateMatch) return null;
  const rest = inner.slice(dateMatch[0].length);
  const vals = [];
  const re = /\{v:(-?\d+),f:"[^"]*"\}|(0)(?=,|$)/g;
  let m;
  while ((m = re.exec(rest))) {
    vals.push(m[1] !== undefined ? Number(m[1]) : 0);
  }
  return { date: dateMatch[1], vals };
}

// gGm([[header...], [row...], ...], "debit"|"credit", ...) の1呼び出し分を
// 取り出してパースする。keyword（例:"売上債権"）を含むヘッダの呼び出しを探す。
function parseGgmChart(html, keyword) {
  const hIdx = html.indexOf(`"${keyword}"`);
  if (hIdx === -1) return null;
  const callStart = html.lastIndexOf('gGm([[', hIdx);
  if (callStart === -1) return null;
  const afterCallStart = callStart + 'gGm(['.length;
  const debitIdx = html.indexOf(',"debit"', afterCallStart);
  const creditIdx = html.indexOf(',"credit"', afterCallStart);
  const candidates = [debitIdx, creditIdx].filter((i) => i !== -1);
  if (!candidates.length) return null;
  const tagIdx = Math.min(...candidates);
  const arraysText = html.slice(afterCallStart, tagIdx + 1);
  const rows = splitTopLevelArrays(arraysText);
  if (rows.length < 2) return null;
  const headerMatches = rows[0].match(/"([^"]*)"/g);
  if (!headerMatches) return null;
  const header = headerMatches.map((s) => s.slice(1, -1));
  const dataRows = rows.slice(1).map(parseRow).filter(Boolean);
  return { header, dataRows };
}

// 最新期（配列の末尾）の売上債権（百万円換算）を返す。取得不能ならnull。
export async function fetchReceivables(code) {
  const html = await getText(`https://irbank.net/${code}/bs`);
  const chart = parseGgmChart(html, '売上債権');
  if (!chart) return { receivables: null, date: null, growthPct: null, prevDate: null };
  const col = chart.header.indexOf('売上債権') - 1; // headerの先頭'year'ぶんvalsとずれる
  const last = chart.dataRows.at(-1);
  const prev = chart.dataRows.at(-2);
  if (!last || col < 0 || col >= last.vals.length) return { receivables: null, date: null, growthPct: null, prevDate: null };
  const receivables = Math.round(last.vals[col] / 1e6); // 円→百万円
  // 前年度比の伸び率（売上高成長率と比較して回収サイクルの異常を見る用）。
  // 前年度がゼロ/未取得なら比較不能としてnullのまま返す（推測しない）。
  let growthPct = null;
  if (prev && Number.isFinite(prev.vals[col]) && prev.vals[col] !== 0) {
    growthPct = Math.round(((last.vals[col] - prev.vals[col]) / prev.vals[col]) * 1000) / 10;
  }
  return { receivables, date: last.date, growthPct, prevDate: prev?.date ?? null };
}

// 配当利回りの過去推移（例年5月時点＋直近の実測値、実測で2010年〜の
// 長期系列あり）。gGmチャートではなく <dl class="gdl"> のリスト形式
// なので別パーサを使う。「過去最高利回りにどれだけ近いか」の判定用。
// 「配当金の状況（円/株）」テーブルを解析する。年度によって同一<tr>内に
// rowspanで複数区分（予想→修正→実績）が畳み込まれた壊れたHTML構造のため、
// tr/td境界には頼らず「年度マーカー」と「区分行」を単一の正規表現で交互に
// 拾い、直前に出現した年度マーカーを各区分行に割り当てる。
// 数値列の構成は銘柄によって異なる（中間/期末/合計の3列、株式分割経験
// 銘柄は合計の後に「分割調整」が加わり4列、期末/合計のみの2列、等）ため、
// 列数を固定せずヘッダー行から「合計」（無ければ分割調整）列の位置を
// 動的に特定して使う。
export function parseDividendYenHistory(html) {
  const startIdx = html.indexOf('配当金の状況');
  if (startIdx === -1) return [];
  const tableEnd = html.indexOf('</table>', startIdx);
  if (tableEnd === -1) return [];
  const section = html.slice(startIdx, tableEnd);
  const theadMatch = section.match(/<thead>([\s\S]*?)<\/thead>/);
  if (!theadMatch) return [];
  const headers = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((h) => h[1].replace(/<[^>]+>/g, '').trim());
  const idxKubun = headers.findIndex((h) => h.includes('区分'));
  const idxYield = headers.findIndex((h) => h.includes('配当') && h.includes('利回り'));
  if (idxKubun === -1 || idxYield === -1) return [];
  const numHeaders = headers.slice(idxKubun + 1, idxYield);
  const totalIdx = numHeaders.findIndex((h) => h.includes('合計'));
  if (totalIdx === -1) return [];
  // 株式分割を経験した銘柄は「合計」列とは別に「分割調整」列（現在の株数
  // 基準に遡って揃えた値）を持つ。「合計」（生の円/株）だけを見ると、
  // 分割があった年に見かけ上「減配」したように見えてしまう（実測:
  // 8227しまむらは分割年に合計280→200と減っているが、分割調整後は
  // 46.67→66.67と実際は増えている）。分割調整列があればそちらを増配/
  // 減配判定・推移表示の基準にする。
  const splitAdjIdx = numHeaders.findIndex((h) => h.includes('分割調整'));
  const amountIdx = splitAdjIdx !== -1 ? splitAdjIdx : totalIdx;

  const re = /(\d{4})年<br>(\d{1,2})月|<span class="co_(?:red|gr|br)">(実績|予想|修正)<\/span><\/td>((?:<td class="(?:rt(?: ffb)?|ct)">(?:[\d.]+|-)<\/td>)+)<td class="rt">([\d.]+)%<\/td>/g;
  const rows = [];
  let period = null;
  let m;
  while ((m = re.exec(section))) {
    if (m[1]) { period = `${m[1]}年${m[2]}月`; continue; }
    if (m[3] !== '実績') continue; // 予想・修正は確定額ではないため増配/減配判定に使わない
    const cells = [...m[4].matchAll(/>([\d.]+|-)</g)].map((c) => c[1]);
    const amount = cells[amountIdx];
    if (amount === undefined || amount === '-') continue;
    rows.push({ period, amount: parseFloat(amount) });
  }
  return rows;
}

// 直近の確定（実績）配当額を年度順に比較し、何期連続で増配/減配が
// 続いているかを数える。据え置き（前年と同額）が挟まると連続増配の
// 定義上そこで途切れるため、streakはそこで打ち切る。
export function computeDividendStreak(yenHistory) {
  if (yenHistory.length < 2) return { streakYears: 0, direction: null };
  const changes = [];
  for (let i = 1; i < yenHistory.length; i++) {
    const diff = yenHistory[i].amount - yenHistory[i - 1].amount;
    changes.push(diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
  }
  let streakYears = 0;
  let direction = null;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i] === 'flat') break;
    if (direction === null) direction = changes[i];
    else if (changes[i] !== direction) break;
    streakYears++;
  }
  return { streakYears, direction };
}

export async function fetchDividendYieldHistory(code, years = 5) {
  const html = await getText(`https://irbank.net/${code}/dividend`);
  const empty = {
    currentYield: null, currentPeriod: null, maxYield: null, maxPeriod: null, approachPct: null, history: [],
    yenHistory: [], streakYears: 0, streakDirection: null,
  };
  const startIdx = html.indexOf('id="g_1"');
  if (startIdx === -1) return empty;
  const endIdx = html.indexOf('</dl>', startIdx);
  if (endIdx === -1) return empty;
  const section = html.slice(startIdx, endIdx);
  const re = /<dt>(\d{4})年(\d{1,2})月.*?<\/dt><dd>.*?<span class="text">([\d.]+)%<\/span>/g;
  const history = [];
  let m;
  while ((m = re.exec(section))) {
    history.push({ period: `${m[1]}年${m[2]}月`, yield: parseFloat(m[3]) });
  }
  if (!history.length) return empty;
  const current = history.at(-1);
  const window = history.slice(-years);
  const maxRow = window.reduce((a, b) => (b.yield > a.yield ? b : a));
  const yenHistory = parseDividendYenHistory(html);
  const { streakYears, direction } = computeDividendStreak(yenHistory);
  // 無配（利回り0%）が続く銘柄は「過去最高への接近率」という概念自体が
  // 意味を持たない（0/0）ため、推測で埋めずnullのままにする。
  // 表示用のyenHistoryは直近6件に切り詰めるが、それだと連続増配年数の
  // 主張（streakYears）を裏付ける実データが画面上の推移に映らないケース
  // が出る（例: 1928積水ハウスは14期連続増配だが直近6件だけでは5回の
  // 変化しか見えず、主張と表示が食い違って見える）。streakYearsを裏付ける
  // のに必要な件数まではウィンドウを広げる。
  return {
    currentYield: current.yield,
    currentPeriod: current.period,
    maxYield: maxRow.yield,
    maxPeriod: maxRow.period,
    approachPct: maxRow.yield > 0 ? Math.round((current.yield / maxRow.yield) * 1000) / 10 : null,
    history,
    yenHistory: yenHistory.slice(-Math.max(6, streakYears + 2)),
    streakYears,
    streakDirection: direction,
  };
}

// 大株主一覧（/{code}/holder）から、筆頭株主の持株比率（浮動株の薄さの
// 目安）と、上位3株主合計の直近の増減（大株主の買い増し傾向）を返す。
//
// ■ なぜ「同じ株主の履歴」ではなく「上位3株主の合計」で増減を見るか
// 各行＝1株主の全期間の履歴だが、信託銀行名義（実質は多数の投資家の
// 合算名義）が上位に出入りすることがあり、筆頭株主自体が期によって
// 別の名義に入れ替わることがある（実測: 7921は2025/11に
// 「USBK NA JP I&W TS」が新規に1位で登場し、それ以前の履歴が無い）。
// 同一株主の履歴を追うと「新規に1位が現れた」だけで増減を計算できない
// ため、株主の同一性に依存しない「上位3株主合計」の期間比較にする。
const EMPTY_SHAREHOLDER_TREND = { top1Pct: null, top3PctNow: null, top3PctChange: null, asOfPeriod: null, checked: false };

// HTML文字列から大株主一覧を解析する（ネットワークを使わない純粋関数。
// テスト容易性のためfetchMajorShareholderTrendから分離）。
export function parseMajorShareholderTrend(html) {
  const tableMatch = html.match(/<table class="bs">([\s\S]*?)<\/table>/);
  if (!tableMatch) return EMPTY_SHAREHOLDER_TREND;
  const theadMatch = tableMatch[1].match(/<thead>([\s\S]*?)<\/thead>/);
  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!theadMatch || !tbodyMatch) return EMPTY_SHAREHOLDER_TREND;

  const headers = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const periods = headers.slice(1); // 先頭列は「大株主」ラベルなので除く。新しい期が先頭。
  if (!periods.length) return EMPTY_SHAREHOLDER_TREND;

  const perPeriodEntries = periods.map(() => []); // [{rank, pct}, ...] を期ごとに集める
  const trRows = [...tbodyMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  for (const tr of trRows) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    tds.slice(1).forEach((cell, i) => {
      const rankMatch = cell.match(/^(\d+)/);
      const pctMatch = cell.match(/([\d.]+)%/);
      if (rankMatch && pctMatch && perPeriodEntries[i]) {
        perPeriodEntries[i].push({ rank: Number(rankMatch[1]), pct: parseFloat(pctMatch[1]) });
      }
    });
  }
  if (!perPeriodEntries[0].length) return EMPTY_SHAREHOLDER_TREND; // 大株主情報が1件も無い（非上場化直前等）

  const top3Sum = (entries) => Math.round(entries.filter((e) => e.rank <= 3).reduce((s, e) => s + e.pct, 0) * 100) / 100;
  const top1Pct = perPeriodEntries[0].find((e) => e.rank === 1)?.pct ?? null;
  const top3PctNow = top3Sum(perPeriodEntries[0]);
  const top3PctChange = perPeriodEntries[1]?.length ? Math.round((top3PctNow - top3Sum(perPeriodEntries[1])) * 100) / 100 : null;

  return { top1Pct, top3PctNow, top3PctChange, asOfPeriod: periods[0], checked: true };
}

export async function fetchMajorShareholderTrend(code) {
  const html = await getText(`https://irbank.net/${code}/holder`);
  return parseMajorShareholderTrend(html);
}
