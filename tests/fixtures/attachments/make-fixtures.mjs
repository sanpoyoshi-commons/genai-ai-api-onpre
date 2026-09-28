// 添付テスト用の最小 fixtures を「自前で」作る（外から拾ってこない）。
//
//   node tests/fixtures/attachments/make-fixtures.mjs
//
// 生成物は同じディレクトリに置き、リポジトリにコミットする。再生成しても内容は変わらない
// （乱数も日時も使っていない）ため、差分が出たら作り方が変わったということ。
//
// PDF は仕様の最小構成を手で組んでいる（依存を足さないため）。
//  - ja-cid.pdf   … Type0 ＋ 定義済み CMap `UniJIS-UCS2-H`・フォント非埋め込み・ToUnicode 無し。
//                   日本語 PDF で普通に出る形で、pdf.js は cmaps/*.bcmap を要求する。
//                   `cMapUrl` を渡さないと本文が空文字になる（例外は出ない）＝退行検知に使う。
//  - en-simple.pdf… 標準14フォント（Helvetica）の ASCII。cmaps は要らない。
//  - many-pages.pdf… 30 ページ。ページ数の上限の確認用。
//  - broken.pdf   … 中身がただのテキスト。壊れたファイルの確認用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.dirname(fileURLToPath(import.meta.url));

/** PDF のオブジェクト列から xref 付きのバイト列を組む。 */
function assemble(objects) {
  const parts = [];
  let size = 0;
  const offsets = [];
  const push = (chunk) => {
    const buf = Buffer.from(chunk, 'latin1');
    parts.push(buf);
    size += buf.length;
  };

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  objects.forEach((body, i) => {
    offsets.push(size);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefAt = size;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** cid=true は UniJIS-UCS2-H（UTF-16BE のコード）、false は Helvetica の latin1。 */
function makePdf({ cid, pageTexts }) {
  const objects = [null, null];
  const pageRefs = [];

  for (const text of pageTexts) {
    const hex = cid
      ? Array.from(text)
          .map((c) => c.codePointAt(0).toString(16).padStart(4, '0'))
          .join('')
      : Buffer.from(text, 'latin1').toString('hex');
    const stream = `BT /F1 24 Tf 72 700 Td <${hex}> Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contentNo = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 __FONT__ 0 R >> >> /Contents ${contentNo} 0 R >>`,
    );
    pageRefs.push(objects.length);
  }

  const fontNo = objects.length + 1;
  if (cid) {
    objects.push(
      `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular ` +
        `/Encoding /UniJIS-UCS2-H /DescendantFonts [${fontNo + 1} 0 R] >>`,
    );
    objects.push(
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 7 >> ` +
        `/FontDescriptor ${fontNo + 2} 0 R /DW 1000 >>`,
    );
    objects.push(
      `<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 ` +
        `/FontBBox [-437 -340 1147 1317] /ItalicAngle 0 /Ascent 1317 /Descent -349 ` +
        `/CapHeight 742 /StemV 80 >>`,
    );
  } else {
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
  return assemble(objects.map((o) => o.replaceAll('__FONT__', String(fontNo))));
}

const write = (name, data) => {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log(`${name}\t${data.length} bytes`);
};

write('ja-cid.pdf', makePdf({ cid: true, pageTexts: ['日本語の本文です'] }));
write('en-simple.pdf', makePdf({ cid: false, pageTexts: ['Hello attachment'] }));
write(
  'many-pages.pdf',
  makePdf({ cid: false, pageTexts: Array.from({ length: 30 }, (_, i) => `PAGE-${i + 1}.`) }),
);
write('broken.pdf', Buffer.from('this is not a pdf at all\n', 'utf8'));

// テキスト系。Shift_JIS と EUC-JP は変換ライブラリを足さないため、バイト列を直に書く。
//   日 = SJIS 93 FA / EUC C6 FC 、本 = SJIS 96 7B / EUC CB DC 、語 = SJIS 8C EA / EUC B8 EC
//   テ = SJIS 83 65 、ス = SJIS 83 58 、ト = SJIS 83 67
write('utf8.txt', Buffer.from('日本語のテキストです\n', 'utf8'));
write('utf8-bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 付きです\n', 'utf8')]));
write(
  'sjis.csv',
  Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2c, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a]),
);
write('eucjp.txt', Buffer.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0x0a]));

// ── html・docx ───────────────────────────────────────────────────────────────
// docx は「STORED（無圧縮）の zip」を手で組む。依存を足さないため（PDF と同じ方針）。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * entries: [{ name, text, declaredSize? }] を STORED の zip にする。
 * `declaredSize` は**中央ディレクトリにだけ**書く嘘の展開後サイズ（zip 爆弾の見立て用）。
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, declaredSize } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 署名
    local.writeUInt16LE(20, 4); // 必要な版
    local.writeUInt16LE(0, 6); // フラグ
    local.writeUInt16LE(0, 8); // 方式＝STORED
    local.writeUInt32LE(0, 10); // 更新日時（0 で固定＝再生成しても同じ内容になる）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 作成した版
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declaredSize ?? data.length, 24); // 展開後サイズ（宣言）
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

write(
  'doc.docx',
  makeZip([
    {
      name: '[Content_Types].xml',
      text:
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      text:
        `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        '<w:p><w:r><w:t>docx の本文です。</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>2行目の段落。</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ]),
);

// html：script・style の中身がモデルへ渡らないことを確かめるため、指示めいた文を入れてある。
write(
  'page.html',
  Buffer.from(
    [
      '<!doctype html>',
      '<html lang="ja"><head><meta charset="utf-8"><title>ページの題</title>',
      '<style>body { color: red } /* STYLE-SHOULD-NOT-APPEAR */</style>',
      '<script>console.log("SCRIPT-SHOULD-NOT-APPEAR");</script>',
      '</head><body>',
      '<h1>見出し</h1>',
      '<p>1つ目の段落です。</p>',
      '<p>2つ目の段落です。</p>',
      '<noscript>NOSCRIPT-SHOULD-NOT-APPEAR</noscript>',
      '</body></html>',
    ].join('\n'),
    'utf8',
  ),
);

// ── xlsx ──────────────────────────────────────────────────────────────────
// 共有文字列（sharedStrings.xml）を使わず inlineStr で書く。read-excel-file は両方読める。

const sheetXml = (rows) =>
  `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">` +
        cells
          .map((cell, c) => {
            const ref = String.fromCharCode(65 + c) + (r + 1);
            return typeof cell === 'number'
              ? `<c r="${ref}"><v>${cell}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
          })
          .join('') +
        '</row>',
    )
    .join('') +
  '</sheetData></worksheet>';

write(
  'sheet.xlsx',
  makeZip([
    {
      name: '[Content_Types].xml',
      text:
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      text:
        `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        '<sheet name="売上" sheetId="1" r:id="rId1"/>' +
        '<sheet name="メモ" sheetId="2" r:id="rId2"/>' +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      text: sheetXml([
        ['品名', '個数'],
        ['りんご', 3],
        ['みかん', 12],
      ]),
    },
    { name: 'xl/worksheets/sheet2.xml', text: sheetXml([['備考の行']]) },
  ]),
);

// zip 爆弾の見立て：中央ディレクトリだけが「展開すると 200MB」と申告する docx。
write(
  'bomb.docx',
  makeZip([
    { name: '[Content_Types].xml', text: `${XML}<Types/>`, declaredSize: 200 * 1024 * 1024 },
    { name: 'word/document.xml', text: `${XML}<w:document/>`, declaredSize: 1024 },
  ]),
);

// ── xlsx の日付・時刻 ──────────────────────────────────────────────────────
// Excel は日付も時刻も「1899-12-30 からの日数」という数で持ち、日付かどうかは
// セルの書式（numFmt）でしか分からない。read-excel-file も書式を見て Date に変える。
// そのため styles.xml を持つ xlsx を組む。
//   s=0 一般 / s=1 日付(numFmt 14) / s=2 時刻(numFmt 20 h:mm) / s=3 日時(numFmt 22)

const EXCEL_EPOCH_1900 = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC の日付を「1899-12-30 からの日数」に。 */
const serialOf = (y, m, d, epoch = EXCEL_EPOCH_1900) => (Date.UTC(y, m - 1, d) - epoch) / DAY_MS;
/** 時刻を1日の割合に。 */
const timeFraction = (h, mi, s = 0) => (h * 3600 + mi * 60 + s) / 86400;

function makeDatesXlsx({ date1904 = false } = {}) {
  const epoch = date1904 ? EXCEL_EPOCH_1904 : EXCEL_EPOCH_1900;
  const dateOnly = serialOf(2026, 9, 27, epoch);
  const time = timeFraction(21, 21);
  const timeWithSeconds = timeFraction(9, 5, 7);
  const cells = [
    ['日付', '時刻', '日時', '秒あり', '数'],
    [
      { v: dateOnly, s: 1 },
      { v: time, s: 2 },
      { v: dateOnly + time, s: 3 },
      { v: timeWithSeconds, s: 2 },
      1234,
    ],
  ];

  const sheet =
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    cells
      .map(
        (row, r) =>
          `<row r="${r + 1}">` +
          row
            .map((cell, c) => {
              const ref = String.fromCharCode(65 + c) + (r + 1);
              if (typeof cell === 'string') {
                return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
              }
              if (typeof cell === 'number') {
                return `<c r="${ref}"><v>${cell}</v></c>`;
              }
              return `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
            })
            .join('') +
          '</row>',
      )
      .join('') +
    '</sheetData></worksheet>';

  return makeZip([
    {
      name: '[Content_Types].xml',
      text:
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      text:
        `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        (date1904 ? '<workbookPr date1904="1"/>' : '') +
        '<sheets><sheet name="日時" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text:
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      text:
        `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
        '<cellXfs count="4">' +
        '<xf numFmtId="0" xfId="0"/>' +
        '<xf numFmtId="14" applyNumberFormat="1" xfId="0"/>' +
        '<xf numFmtId="20" applyNumberFormat="1" xfId="0"/>' +
        '<xf numFmtId="22" applyNumberFormat="1" xfId="0"/>' +
        '</cellXfs></styleSheet>',
    },
    { name: 'xl/worksheets/sheet1.xml', text: sheet },
  ]);
}

write('dates.xlsx', makeDatesXlsx());
write('dates-1904.xlsx', makeDatesXlsx({ date1904: true }));
