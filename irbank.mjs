// ==================================================================
// irbank.mjs — IR Bank（irbank.net）から配当履歴・PBR推移・大株主構成を取得
//
//  robots.txtはUser-agent:*にAllow:/（AIクローラー個別ブロックなし）。
//  Buffett Codeはrobots.txtでClaudeBot/anthropic-ai等を名指しでDisallow
//  しているため、そちらは使わない。
//
//  ■ 貸借対照表項目（売掛金・現金及び預金・自己資本等）について
//  以前はここ（/{code}/bs のGoogle Chartsデータ）から売掛金を補っていたが、
//  法定開示書類（XBRL）を直接パースできるEDINET（edinet.mjs）に置き換えた。
//  相対年度ラベルが最初からタグに含まれ決算期の誤認バグが構造的に起きない
//  ため、貸借対照表項目は今後もEDINET側に一本化する。
// ==================================================================
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
export const REQ_GAP = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kabutan.mjsと同じ理由（Macのスリープ中にfetchが無期限に応答待ちになり
// プロセス全体がハングする事象の再発防止）でタイムアウトを設ける。
const FETCH_TIMEOUT_MS = 30_000;

async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (res.ok) return await res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
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

// IR Bankの<dl class="gdl">形式（id="g_1"の折れ線グラフのデータ部分）を解析する
// 共通ヘルパー。配当利回り推移(/dividend, 単位"%")とPBR推移(/pbr, 単位"倍")は
// どちらも同じHTML構造（<dt>年月...</dt><dd>...<span class="text">数値+単位</span></dd>）
// を使っているため、パーサ自体を共有できる。
function parseGdlSeries(html, unit) {
  const startIdx = html.indexOf('id="g_1"');
  if (startIdx === -1) return [];
  const endIdx = html.indexOf('</dl>', startIdx);
  if (endIdx === -1) return [];
  const section = html.slice(startIdx, endIdx);
  const re = new RegExp(`<dt>(\\d{4})年(\\d{1,2})月.*?<\\/dt><dd>.*?<span class="text">([\\d.]+)${unit}<\\/span>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(section))) {
    out.push({ period: `${m[1]}年${m[2]}月`, value: parseFloat(m[3]) });
  }
  return out;
}

export async function fetchDividendYieldHistory(code, years = 5) {
  const html = await getText(`https://irbank.net/${code}/dividend`);
  const empty = {
    currentYield: null, currentPeriod: null, maxYield: null, maxPeriod: null, approachPct: null, history: [],
    yenHistory: [], streakYears: 0, streakDirection: null,
  };
  const series = parseGdlSeries(html, '%');
  if (!series.length) return empty;
  const history = series.map((s) => ({ period: s.period, yield: s.value }));
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

// 過去のPBRレンジ（IR Bank）。コンセンサス（アナリスト予想）が無い銘柄は
// 「未来の期待値」で判定できないため、代わりに「過去の事実」として
// 自分自身の過去のPBR推移の中で今がどの位置にあるかを見る
// （過去最低PBRにどれだけ近いか＝歴史的に見て割安な水準かの目安）。
// IR Bank無料版は概ね2012年〜の年次スナップショットを持つ（銘柄により
// 上場年次第で開始年は異なる）。
const EMPTY_PBR_HISTORY = { currentPbr: null, currentPeriod: null, minPbr: null, minPeriod: null, history: [] };

// HTML文字列からPBR推移を解析する（ネットワークを使わない純粋関数。
// テスト容易性のためfetchPbrHistoryから分離。parseMajorShareholderTrend
// と同じ設計）。
export function parsePbrHistory(html) {
  const series = parseGdlSeries(html, '倍');
  if (!series.length) return EMPTY_PBR_HISTORY;
  const current = series.at(-1);
  const minRow = series.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    currentPbr: current.value,
    currentPeriod: current.period,
    minPbr: minRow.value,
    minPeriod: minRow.period,
    history: series.map((s) => ({ period: s.period, pbr: s.value })),
  };
}

export async function fetchPbrHistory(code) {
  return parsePbrHistory(await getText(`https://irbank.net/${code}/pbr`));
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
