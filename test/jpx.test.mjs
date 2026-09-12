// jpx.mjs — JPX上場銘柄一覧（xlsx）のパース。ユーザー要望2026-09-13
// 「スキャンの範囲もう少し広げられませんか」への対応。xlsxは実体が
// zipアーカイブ（中身はXML）なので、edinet.mjsのunzip()を流用し新規の
// 依存ライブラリを追加せずに済ませている。ここでは実際のxlsx内部形式
// （sharedStrings.xml/sheet1.xml、実データで確認済み）を模した最小限の
// フィクスチャで検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSharedStrings, parseSheetRows, parseListedIssuesXlsx } from '../jpx.mjs';
import { buildUniverse } from '../smart_entry.mjs';

test('parseSharedStrings: <si><t>...</t></si>の並び順をそのままインデックスとして返す（実データ形式）', () => {
  const xml = '<sst><si><t>コード</t></si><si><t>銘柄名</t></si><si><t>極洋</t></si></sst>';
  assert.deepEqual(parseSharedStrings(xml), ['コード', '銘柄名', '極洋']);
});

test('parseSheetRows: t="s"のセルは共有文字列に解決し、それ以外は生の値をそのまま返す（実データ形式）', () => {
  const shared = ['コード', '銘柄名', '1301', '極洋'];
  const xml = '<sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
    '</sheetData>';
  const rows = parseSheetRows(xml, shared);
  assert.deepEqual(rows[0], { A: 'コード', B: '銘柄名' });
  assert.deepEqual(rows[1], { A: '1301', B: '極洋' });
});

// 実際のxlsx（zip+XML）を自前で最小限組み立てて、unzip()経由の
// end-to-endも検証する（edinet.mjsのunzip()実装が対応するstore方式
// [非圧縮]のZIPエントリで組み立てる）。
function buildXlsxFixture(sharedStringsXml, sheetXml) {
  const files = [
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf-8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf-8') },
  ];
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method=store(非圧縮)
    localHeader.writeUInt32LE(f.data.length, 18); // compressed size
    localHeader.writeUInt32LE(f.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([localHeader, nameBuf, f.data]);
    localParts.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0, 10); // method=store
    centralHeader.writeUInt32LE(f.data.length, 20);
    centralHeader.writeUInt32LE(f.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += local.length;
  }
  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

test('parseListedIssuesXlsx: 実データ形式のxlsx（zip）から{code,name,market,sector33}を抽出し、見出し行は除外する', () => {
  const sharedStringsXml = '<sst><si><t>日付</t></si><si><t>コード</t></si><si><t>銘柄名</t></si>' +
    '<si><t>市場・商品区分</t></si><si><t>33業種コード</t></si><si><t>33業種区分</t></si>' +
    '<si><t>20260831</t></si><si><t>1301</t></si><si><t>極洋</t></si>' +
    '<si><t>プライム（内国株式）</t></si><si><t>50</t></si><si><t>水産・農林業</t></si></sst>';
  const sheetXml = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>8</v></c><c r="D2" t="s"><v>9</v></c><c r="E2" t="s"><v>10</v></c><c r="F2" t="s"><v>10</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = buildXlsxFixture(sharedStringsXml, sheetXml);
  const issues = parseListedIssuesXlsx(buf);
  assert.equal(issues.length, 1); // 見出し行(コード='コード'は4桁コード形式に一致しないため除外)
  assert.equal(issues[0].code, '1301');
  assert.equal(issues[0].name, '極洋');
  assert.equal(issues[0].market, 'プライム（内国株式）');
});

test('buildUniverse: jpxNamesも他のソースと同じ和集合として合流する（実例: TOWA(6315)）', () => {
  const universe = buildUniverse({ tdNames: {}, sbiStocks: {}, jpxNames: { '6315': 'ＴＯＷＡ' } });
  assert.equal(universe['6315'], 'ＴＯＷＡ');
});

test('buildUniverse: jpxNamesに既にtdNames/sbiStocksにある銘柄があれば、そちらの名前を優先する', () => {
  const universe = buildUniverse({ tdNames: { '6315': 'TDnet表記の名前' }, sbiStocks: {}, jpxNames: { '6315': 'ＴＯＷＡ' } });
  assert.equal(universe['6315'], 'TDnet表記の名前');
});
