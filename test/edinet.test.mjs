// edinet.mjs（EDINET財務データ）の回帰テスト。
//
// フィクスチャ（test/fixtures/edinet_sample.zip）は株式会社ドーン
// （証券コード2303）が実際にEDINETへ提出した有価証券報告書
// （docID: S100YXLE, 2026-08-21提出）のXBRL-to-CSV変換データそのもの。
// 有価証券報告書は金融商品取引法に基づき公開される法定開示書類であり、
// 官報に準じる公的な情報として再配布に制約が無いため、実データを
// そのままテストフィクスチャとして使用している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip, parseFinancialCsv, extractBalanceSheetSnapshot, toFourDigitCode, pickLatestPerCode } from '../edinet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zipBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'edinet_sample.zip'));
// 半期報告書（docTypeCode=160）の実データ。TAKARA & COMPANY(7921)が実際に
// EDINETへ提出した半期報告書（docID: S100XEX3, 2026-01-09提出）の
// XBRL-to-CSV変換データそのもの（有価証券報告書と同じく法定開示書類）。
const interimZipBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'edinet_interim_sample.zip'));

test('unzip: EDINETのストリーミング形式ZIP（ローカルヘッダの圧縮サイズが0）を正しく解凍する', () => {
  // 実測バグ: EDINETのZIPはデータディスクリプタ形式（ローカルヘッダの
  // 圧縮後/圧縮前サイズが0）で、ローカルヘッダの値をそのまま信用すると
  // zlib.inflateRawSyncが「unexpected end of file」で失敗していた。
  // セントラルディレクトリ経由で読むことで解決した。
  const entries = unzip(zipBuf);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => /jpcrp030000-asr/.test(e.name)));
  assert.ok(entries.some((e) => /jpaud-aai/.test(e.name)));
});

test('parseFinancialCsv → extractBalanceSheetSnapshot: 貸借対照表項目を実際の値と一致させる', () => {
  const entries = unzip(zipBuf);
  const table = parseFinancialCsv(entries);
  const snap = extractBalanceSheetSnapshot(table);
  // ドーン(2303) 第35期(2025/06/01-2026/05/31)有価証券報告書の実際の値。
  assert.equal(snap.receivables, 172773000); // 売掛金(当期末)
  assert.equal(snap.cash, 1801822000); // 現金及び預金(当期末)
  assert.equal(snap.equity, 2987648000); // 純資産(当期末)
  assert.equal(snap.totalAssets, 3343042000); // 資産(当期末)
  assert.equal(snap.retainedEarnings, 2761351000); // 利益剰余金(当期末)
  assert.equal(snap.investmentSecurities, 911776000); // 投資有価証券(当期末)
  // 前期末(313,876,000)からの伸び率。同一書類内に比較貸借対照表として
  // 前期末の値も含まれているため、別ページ取得なしで算出できる。
  assert.equal(snap.receivablesGrowthPct, -45);
});

test('extractBalanceSheetSnapshot: 研究開発費（jppfs_cor:ResearchAndDevelopmentExpensesSGA）を取得し前期比を計算する（実測: 3Dマトリックス/7777の有報 S100YR3Gで確認済み。当初憶測していたResearchAndDevelopmentExpenseタグではなくSGA付きが正しいタグ名だった）', () => {
  const table = {
    'jppfs_cor:ResearchAndDevelopmentExpensesSGA': { '当期': 640210000, '前期': 498200000 },
  };
  const snap = extractBalanceSheetSnapshot(table);
  assert.equal(snap.rndExpense, 640210000);
  assert.equal(snap.rndGrowthPct, 28.5); // (640210000-498200000)/498200000*100
});

test('extractBalanceSheetSnapshot: 研究開発費を開示していない銘柄はnull（推測で埋めない）', () => {
  const snap = extractBalanceSheetSnapshot({});
  assert.equal(snap.rndExpense, null);
  assert.equal(snap.rndGrowthPct, null);
});

test('parseFinancialCsv: 純資産の内訳行（資本金・利益剰余金等）が合計値を上書きしない', () => {
  // 実測バグ: jppfs_cor:NetAssetsは「当期末」ラベルのまま資本金・
  // 利益剰余金等の内訳行が10件以上並んでおり、コンテキストIDを見ずに
  // 「同じ要素ID+同じ相対年度なら上書き」としていたため、内訳行の
  // どれかが合計値を上書きする可能性があった（たまたま合計行が最後に
  // 来ていたため当初は気づかれにくかった）。コンテキストIDが
  // 「...ConsolidatedMember」ちょうどで終わる行（内訳の追加サフィックス
  // が無い＝合計そのもの）だけを採用するよう修正した。
  const entries = unzip(zipBuf);
  const table = parseFinancialCsv(entries);
  // 内訳行（例: 資本金 363,950,000）が合計(2,987,648,000)に紛れ込んで
  // いないことを確認する。
  assert.equal(table['jppfs_cor:NetAssets']?.['当期末'], 2987648000);
});

test('toFourDigitCode: EDINETのsecCode(5桁)から4桁の証券コードに変換する', () => {
  assert.equal(toFourDigitCode('79210'), '7921');
  assert.equal(toFourDigitCode('23030'), '2303');
  assert.equal(toFourDigitCode(null), null);
});

test('pickLatestPerCode: 有報/四半期/半期以外（変更報告書など）や CSV非対応(csvFlag!=1)の書類は無視する', () => {
  const docs = [
    { secCode: '79210', docTypeCode: '350', csvFlag: '1', docID: 'X1' }, // 変更報告書
    { secCode: '79210', docTypeCode: '120', csvFlag: '0', docID: 'X2' }, // CSV非対応
    { secCode: '79210', docTypeCode: '120', csvFlag: '1', docID: 'X3' }, // 有報
  ];
  const hits = pickLatestPerCode(docs, new Set(['7921']));
  assert.equal(hits.size, 1);
  assert.equal(hits.get('7921').docID, 'X3');
});

test('pickLatestPerCode: 同じコードが1日の一覧に複数回ヒットしても最初の1件だけを採用する', () => {
  const docs = [
    { secCode: '79210', docTypeCode: '160', csvFlag: '1', docID: 'FIRST' },
    { secCode: '79210', docTypeCode: '120', csvFlag: '1', docID: 'SECOND' },
  ];
  const hits = pickLatestPerCode(docs, new Set(['7921']));
  assert.equal(hits.size, 1);
  assert.equal(hits.get('7921').docID, 'FIRST');
});

test('pickLatestPerCode: alreadyFoundに含まれるコードは（新しい日から遡る走査で既に確定済みなので）再走査しない', () => {
  // 実測バグの再発防止: lookbackDaysを日ごとに遡って呼び出す設計上、
  // 「その銘柄はもっと新しい日で既に見つかっている」場合に古い日の
  // ヒットで上書きしてはならない（buildDocumentIndexが未確定コードだけを
  // 走査対象コード集合に残す前提のテスト）。
  const docs = [{ secCode: '79210', docTypeCode: '120', csvFlag: '1', docID: 'OLDER' }];
  const hits = pickLatestPerCode(docs, new Set(['7921']), new Set(['7921']));
  assert.equal(hits.size, 0);
});

test('extractBalanceSheetSnapshot: 半期報告書（コンテキストIDが有報と別体系）でも貸借対照表項目を正しく取得する', () => {
  // 実測バグ: 半期報告書は"InterimInstant"（サフィックス無しの裸）を
  // 使うのに対し、旧TOTAL_CONTEXT_REは有報の"..._NonConsolidatedMember"
  // サフィックス必須の正規表現だったため、半期報告書ではどの行にも
  // マッチせず全項目nullになっていた（実測: 7921の半期報告書S100XEX3）。
  const entries = unzip(interimZipBuf);
  const table = parseFinancialCsv(entries);
  const snap = extractBalanceSheetSnapshot(table);
  // TAKARA & COMPANY(7921) 半期報告書(2025/06/01-2025/11/30)の実際の値。
  assert.equal(snap.receivables, 3455662000); // 受取手形及び売掛金(当中間期末)
  assert.equal(snap.cash, 20035717000); // 現金及び預金(当中間期末)
  assert.equal(snap.equity, 31122097000); // 純資産(当中間期末)
  assert.equal(snap.totalAssets, 38849642000); // 資産(当中間期末)
  assert.equal(snap.retainedEarnings, 22781819000); // 利益剰余金(当中間期末)
  assert.equal(snap.investmentSecurities, 3525109000); // 投資有価証券(当中間期末)
});

test('extractBalanceSheetSnapshot: 半期報告書は売掛金の伸び率を計算しない（決算期末との比較は季節性で水準が違うため異常値と誤認しかねない）', () => {
  // 半期報告書の売掛金・現金等の勘定科目には「前中間期末」（同じ時点の
  // 前年比較）が無く「前期末」（決算期末）しか無い。当中間期末(期中)と
  // 前期末(決算期末)は季節要因で残高水準が異なるのが通常なので、
  // 単純に伸び率を出すと季節性による減少を「異常な急減」と誤認する
  // リスクがある。有報（当期末/前期末が両方とも決算期末どうし）でのみ
  // 伸び率を計算する。
  const entries = unzip(interimZipBuf);
  const table = parseFinancialCsv(entries);
  const snap = extractBalanceSheetSnapshot(table);
  assert.equal(snap.receivablesGrowthPct, null);
});

test('pickLatestPerCode: 追跡対象コード集合に無い銘柄は無視する', () => {
  const docs = [{ secCode: '99990', docTypeCode: '120', csvFlag: '1', docID: 'X' }];
  const hits = pickLatestPerCode(docs, new Set(['7921']));
  assert.equal(hits.size, 0);
});
