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
