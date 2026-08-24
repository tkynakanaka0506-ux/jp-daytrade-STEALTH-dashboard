// ==================================================================
// edinet.mjs — EDINET（金融庁）APIから財務データを取得
//
//  ■ なぜ導入したか
//  kabutan/IR Bankのスクレイピングでは「決算期セルの表記だけから予想/
//  実績を見分ける」「列構成が銘柄によって違う」といった問題が繰り返し
//  発生した（このセッションで複数回のバグ修正）。EDINETのXBRL由来CSVは
//  各数値に「相対年度（前期末/当期末/当期/前期）」が明示的なタグとして
//  付与されており、そもそも見分ける必要が無い。政府の公式APIのため
//  robots.txt/ボット検知の心配も無い（J-Quantsで発生したWAF由来の
//  ForbiddenExceptionはEDINETでは起きない。無効なAPIキーでも
//  "Access denied due to invalid subscription key"という具体的な
//  エラーが返り、正規の認証層に到達していることを確認済み）。
//
//  ■ ハイブリッド方針（貸借対照表項目のみ対象）
//  EDINETの正式書類（有価証券報告書=年1回・3ヶ月以内、四半期報告書=
//  年3回・45日以内）は、kabutanが情報源にしているTDnet「決算短信」
//  （速報版、通常2〜4週間で開示）より法定提出期限の関係で数週間〜
//  1ヶ月以上遅れる。AMBUSHの「決算先読み」は決算直後の鮮度が命なので、
//  営業利益・進捗率はkabutan側の速いパイプラインを維持し、EDINETは
//  「多少遅れて確定しても正確さが優先される」貸借対照表のスナップ
//  ショット項目（売掛金・現金及び預金・自己資本）だけを置き換える。
//
//  ■ APIキー
//  .env の EDINET_API_KEY を使う（無料・即時発行、審査なし）。
//
//  ■ ZIP解凍について
//  書類取得API（type=5）はXBRLをCSVに変換したファイル一式をZIPで返す。
//  EDINETが返すZIPはストリーミング形式（ローカルヘッダの圧縮後/前
//  サイズが0で、セントラルディレクトリにのみ正しい値が入っている）
//  なので、セントラルディレクトリ経由で解凍する。圧縮方式はdeflateで
//  Node標準のzlibだけで展開できるため、外部ライブラリは使わない。
// ==================================================================
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const BASE = 'https://api.edinet-fsa.go.jp/api/v2';
export const REQ_GAP = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// .envから読み込む（プロジェクト内の簡易dotenv。外部ライブラリ不要）。
function loadEnvKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      if (k === name) return line.slice(eq + 1).trim();
    }
  } catch { /* .env未作成（未登録環境） */ }
  return null;
}

async function apiGet(pathAndQuery, { binary = false } = {}) {
  const key = loadEnvKey('EDINET_API_KEY');
  if (!key) throw new Error('EDINET_API_KEY が .env に設定されていません');
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}Subscription-Key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

// ------------------------------------------------------------------
// 書類一覧API（今日/指定日に提出された書類のメタデータ一覧）
// ------------------------------------------------------------------
export async function fetchDocumentList(dateIso) {
  const data = await apiGet(`/documents.json?date=${dateIso}&type=2`);
  return data.results ?? [];
}

// secCodeは5桁（4桁+チェックデジット）で返るため、4桁の証券コードと
// 比較するときは末尾を切り落とす。
export const toFourDigitCode = (secCode) => (secCode ? String(secCode).slice(0, 4) : null);

// ------------------------------------------------------------------
// ZIP解凍（外部ライブラリ不要・zlib.inflateRawSyncのみ使用）
//
// EDINETが返すZIPはストリーミング形式（ローカルヘッダの圧縮前後サイズが
// 0）なので、常に正しい値を持つセントラルディレクトリ経由で読む。
// ------------------------------------------------------------------
function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('EOCDが見つかりません（正しいZIPではない）');
}

export function unzip(buf) {
  const eocdOffset = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央ディレクトリのシグネチャが不正です');
    const compMethod = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);

    // ローカルヘッダはファイル名長・追加フィールド長だけ信用し、圧縮
    // サイズ等は（ストリーミング形式で0のことがあるため）セントラル
    // ディレクトリの値を使う。
    const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const data = compMethod === 0 ? compData : zlib.inflateRawSync(compData);
    entries.push({ name, data });

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ------------------------------------------------------------------
// 財務諸表CSV（XBRL_TO_CSV/配下、UTF-16LE・タブ区切り）を
// { 要素ID: { 相対年度: 値(円) } } の形に変換する。
// 「jpcrp」（有価証券報告書等の本体）ファイルだけを対象にする
// （jpaudは監査報告書で財務数値を含まない）。
// ------------------------------------------------------------------
// コンテキストIDが「合計そのもの」を指しているか判定する。
// 純資産・株主資本合計等の勘定科目は、同じ要素ID・同じ相対年度ラベルの
// まま「資本金」「利益剰余金」等の内訳行が複数並ぶ（実測:
// jppfs_cor:NetAssetsが「当期末」ラベルのまま10行以上出現し、内訳が
// 合計値を後から上書きしてしまっていた）。内訳行のコンテキストIDは
// 必ず「...ConsolidatedMember」の後ろに追加の"_XxxMember"が付くため、
// それが無い（＝合計そのものを指す）行だけを採用する。
//
// 実測バグ: 半期報告書（docTypeCode=160）は有報と全く別のコンテキストID
// 体系を使う。有報は "CurrentYearInstant_NonConsolidatedMember" のように
// 必ず連結・個別の"_(Non)ConsolidatedMember"サフィックスが付くが、半期は
// "InterimInstant"（サフィックス無し・裸）で連結/個別の区別は別列
// （"連結・個別"列）にしか無い。旧正規表現はサフィックス必須だったため
// 半期報告書ではどの行も一致せず、実在する書類を見つけても財務項目が
// 全てnullになっていた（実測: 7921の半期報告書 S100XEX3）。
// サフィックスを「有れば(Non)?ConsolidatedMemberのみ許可・無ければ裸のまま
// 終端」の二択にすることで、両方の体系の合計行だけを採用しつつ、
// "_No1MajorShareholdersMember"等の内訳行（サフィックスが上記以外）は
// 引き続き除外する。
const TOTAL_CONTEXT_RE = /^(CurrentYear|Interim|Prior\d+Year|Prior\d+Interim)(Instant|Duration)(_(Non)?ConsolidatedMember)?$/;

export function parseFinancialCsv(entries) {
  const target = entries.find((e) => /XBRL_TO_CSV\/jpcrp/.test(e.name));
  if (!target) return {};
  const text = target.data.toString('utf16le').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = {};
  // 1行目はヘッダ（"要素ID"\t"項目名"\t"コンテキストID"\t"相対年度"\t...）
  // なので飛ばす。
  for (const line of lines.slice(1)) {
    const cells = line.split('\t').map((c) => c.replace(/^"|"$/g, ''));
    if (cells.length < 9) continue;
    const [elementId, , contextId, relativeYear, consolidated, , , , rawValue] = cells;
    if (!TOTAL_CONTEXT_RE.test(contextId)) continue; // 内訳行は除外し合計のみ採用
    const value = Number(rawValue.replace(/,/g, ''));
    if (!elementId || !Number.isFinite(value)) continue;
    if (!out[elementId]) out[elementId] = {};
    // 連結・個別のうち「連結」を優先する（無ければ個別を使う）。
    const existing = out[elementId][relativeYear];
    if (existing === undefined || consolidated === '連結') {
      out[elementId][relativeYear] = value;
    }
  }
  return out;
}

// 決算期テーブルでkabutan側に既にある「予想行を実績と誤認する」バグ
// （このセッションで複数回発見・修正）が、EDINET側では構造的に起き
// ない：相対年度ラベル（当期末/前期末）が最初からタグに含まれるため。
const pick = (table, elementId, ...relativeYears) => {
  const row = table[elementId];
  if (!row) return null;
  for (const y of relativeYears) {
    if (row[y] !== undefined) return row[y];
  }
  return null;
};

const pct = (current, prior) => (current != null && prior) ? Math.round(((current / prior) - 1) * 1000) / 10 : null;

// 有報（当期末/前期末＝決算期末どうしの1年比較）と半期報告書（当中間期末＝
// 期中の値）とでは相対年度ラベルの体系が異なる（実測: 7921の半期報告書
// S100XEX3では"当期末"ラベルは一切登場せず"当中間期末"のみ）。
// comparable:falseの半期報告書には「前中間期末」との同時点比較データが
// 売掛金・現金等の勘定科目には存在しない（実測: jpcrp_cor側の経営指標
// 要約にのみ前中間期末が付き、jppfs_cor側の実勘定科目には前期末＝決算期末
// との比較しか無い）。決算期末(通年)と期中(半期)は季節性で残高の水準が
// 異なるのが通常なので、両者を混ぜて伸び率を出すと「季節要因による減少」
// を「異常な急減」と誤認しかねない。半期報告書からは伸び率を出さず、
// 有報が見つかった場合のみreceivablesGrowthPctを計算する。
const PERIOD_SCHEMES = [
  { current: '当期末', prior: '前期末', comparable: true }, // 有価証券報告書
  { current: '当中間期末', prior: null, comparable: false }, // 半期報告書
];

const two = (table, elementIds, year) => {
  for (const id of elementIds) {
    const v = pick(table, id, year, `${year}現在`);
    if (v !== null) return v;
  }
  return null;
};

// IFRS採用企業はjppfs_corではなくjpigp_cor（国際会計基準用）タグを使う
// ことがあるため両方を試す。売掛金は「売掛金」単独のタグと「受取手形及び
// 売掛金」を一体で計上するタグの2通りがある（実測: 有報は
// jppfs_cor:AccountsReceivableTrade、半期報告書はjppfs_cor:
// NotesAndAccountsReceivableTradeを使用）。
const RECEIVABLES_IDS = ['jppfs_cor:AccountsReceivableTrade', 'jppfs_cor:NotesAndAccountsReceivableTrade', 'jpigp_cor:TradeAndOtherReceivables'];
const CASH_IDS = ['jppfs_cor:CashAndDeposits', 'jpigp_cor:CashAndCashEquivalents'];
const EQUITY_IDS = ['jppfs_cor:NetAssets', 'jpigp_cor:Equity'];
const ASSETS_IDS = ['jppfs_cor:Assets', 'jpigp_cor:Assets'];
// 利益剰余金（株主還元ポテンシャルの予兆判定用）・投資有価証券
// （政策保有株等。含み資産の予兆判定用）。「カタリスト予兆」セクション
// のために追加した2項目。IFRS採用企業のタグ名は実データで未確認のため
// jppfs_cor（日本基準）のみを候補にしている（該当が無ければnullのまま
// 推測で埋めない）。
const RETAINED_EARNINGS_IDS = ['jppfs_cor:RetainedEarnings'];
const INVESTMENT_SECURITIES_IDS = ['jppfs_cor:InvestmentSecurities'];

// 貸借対照表スナップショット項目（売掛金・現金及び預金・自己資本・
// 総資産・利益剰余金・投資有価証券）を最新の実績値で返す。
export function extractBalanceSheetSnapshot(table) {
  const hasLabel = (label) => Object.values(table).some((row) => label in row);
  const scheme = PERIOD_SCHEMES.find((sc) => hasLabel(sc.current)) ?? PERIOD_SCHEMES[0];
  const receivables = two(table, RECEIVABLES_IDS, scheme.current);
  const receivablesPrior = scheme.comparable ? two(table, RECEIVABLES_IDS, scheme.prior) : null;
  return {
    receivables,
    receivablesGrowthPct: pct(receivables, receivablesPrior),
    cash: two(table, CASH_IDS, scheme.current),
    equity: two(table, EQUITY_IDS, scheme.current),
    totalAssets: two(table, ASSETS_IDS, scheme.current),
    retainedEarnings: two(table, RETAINED_EARNINGS_IDS, scheme.current),
    investmentSecurities: two(table, INVESTMENT_SECURITIES_IDS, scheme.current),
  };
}

// ------------------------------------------------------------------
// 指定した証券コード群の直近の有価証券報告書/四半期報告書/半期報告書を
// まとめて探す。
//
// ■ 実測で発覚したバグ（lookbackDays=120は構造的に短すぎる）
// 有価証券報告書は年1回・決算日から3ヶ月以内に提出される（例:
// TAKARA & COMPANY(7921)は決算日5/31・提出期限8/31）。「前回提出分」は
// 次回提出までの最大12ヶ月+3ヶ月弱、有効な最新データであり続けるのに、
// 120日ではその大半の期間でN/Aになってしまう（実測: 7921は前回提出が
// 2025-08-20で、今回提出予定の直前である現在(2026-08-23時点)は120日
// 走査で完全に空振りし、実際にはまだ存在するはずの「前回分」も
// 取りこぼしていた）。決算月が分散した銘柄群を扱うため、1年分の
// フィスカルサイクル+提出猶予をカバーできるまで遡る必要がある。
//
// ■ 銘柄ごとに逐次スキャンしない理由
// EDINETには銘柄コード単体で書類を検索するAPIが無く「日付→その日の
// 全提出書類一覧」しか無い。銘柄ごとにlookbackDays日分を逐次走査すると
// 銘柄数×日数のリクエストが必要になり非現実的（27銘柄×400日は破綻する）。
// 追跡銘柄コードの集合を渡し、日付ごとに1回だけ一覧を取得して該当銘柄
// すべてを同時に拾う（新しい日から遡るため、コードごとに最初に見つかった
// ものが最新＝以降の同一コードの重複ヒットは無視してよい）。
// ------------------------------------------------------------------
const BS_DOC_TYPES = new Set(['120', '140', '160']); // 有報・四半期・半期報告書
const empty = {
  receivables: null, receivablesGrowthPct: null, cash: null, equity: null, totalAssets: null,
  retainedEarnings: null, investmentSecurities: null, docID: null, submitDateTime: null, periodEnd: null,
};

// 1日分の書類一覧から、追跡対象コード集合に該当する最新候補を拾う
// （ネットワーク非依存の純粋関数。テストで直接検証できるよう分離）。
export function pickLatestPerCode(docs, codeSet, alreadyFound = new Set()) {
  const hits = new Map();
  for (const d of docs) {
    const code = toFourDigitCode(d.secCode);
    if (!code || !codeSet.has(code) || alreadyFound.has(code) || hits.has(code)) continue;
    if (!BS_DOC_TYPES.has(d.docTypeCode) || d.csvFlag !== '1') continue;
    hits.set(code, d);
  }
  return hits;
}

// 追跡銘柄すべての最新書類メタデータを1回の日次走査で構築する。
// 全銘柄が見つかった時点で残り日数の走査を打ち切る（実行時間の節約）。
export async function buildDocumentIndex(codes, lookbackDays = 400) {
  const codeSet = new Set(codes);
  const index = new Map();
  for (let i = 0; i < lookbackDays && index.size < codeSet.size; i++) {
    const iso = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    let docs;
    try {
      docs = await fetchDocumentList(iso);
    } catch {
      await sleep(REQ_GAP);
      continue;
    }
    const hits = pickLatestPerCode(docs, codeSet, index);
    for (const [code, d] of hits) index.set(code, d);
    await sleep(REQ_GAP);
  }
  return index;
}

// インデックスの1件を実際にダウンロード・解凍・パースして貸借対照表
// スナップショットを返す。
export async function fetchBalanceSheetSnapshot(docMeta) {
  if (!docMeta) return empty;
  const zipBuf = await apiGet(`/documents/${docMeta.docID}?type=5`, { binary: true });
  const entries = unzip(zipBuf);
  const table = parseFinancialCsv(entries);
  const snap = extractBalanceSheetSnapshot(table);
  return { ...snap, docID: docMeta.docID, submitDateTime: docMeta.submitDateTime, periodEnd: docMeta.periodEnd };
}

// 追跡銘柄コード配列 → { code: スナップショット } のMapをまとめて返す
// 便利関数（buildDocumentIndex + fetchBalanceSheetSnapshotを合成）。
export async function fetchBalanceSheetSnapshots(codes, lookbackDays = 400) {
  const index = await buildDocumentIndex(codes, lookbackDays);
  const out = new Map();
  for (const code of codes) {
    const hit = index.get(code);
    if (!hit) { out.set(code, empty); continue; }
    try {
      await sleep(REQ_GAP);
      out.set(code, await fetchBalanceSheetSnapshot(hit));
    } catch (e) {
      console.error(`  ⚠️ EDINET ${code} 財務データ取得失敗: ${e.message}`);
      out.set(code, empty);
    }
  }
  return out;
}
