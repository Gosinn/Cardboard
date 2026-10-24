import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32 as zlibCrc } from "node:zlib";
import {
  crc32,
  docxToText,
  fromBase64,
  jsonToRows,
  makeZip,
  markdownToHtml,
  parseCsv,
  readZip,
  rowsToJson,
  rowsToXlsx,
  sniff,
  textToPdf,
  toBase64,
  toCsv,
  toYaml,
  xlsxToRows,
} from "../src/client/formats.ts";
import { encodeGif, encodeIco, encodeWav, oggCrc, OggOpusWriter } from "../src/client/media.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("formats the converter writes and reads", () => {
  it("zips and unzips, with the same CRC-32 as zlib", async () => {
    assert.equal(crc32(text("hello world")), zlibCrc("hello world"));
    const files = [
      { name: "notes/a.txt", data: text("abc ".repeat(1000)) },
      { name: "ð.bin", data: Uint8Array.of(1, 2, 3) },
      { name: "notes/a.txt", data: text("second") },
      { name: "notes/a.txt", data: text("third") },
    ];
    const back = await readZip(await makeZip(files));
    assert.deepEqual(
      back.map((e) => e.name),
      ["notes/a.txt", "ð.bin", "notes/a (2).txt", "notes/a (3).txt"],
    );
    assert.deepEqual(back[0]!.data, files[0]!.data);
    await assert.rejects(readZip(text("not a zip")), /isn't a \.zip/);
  });

  it("stops unpacking a zip that grows past what it may (a zip bomb)", async () => {
    const bomb = await makeZip([{ name: "zeros", data: new Uint8Array(4 * 1024 * 1024) }]);
    assert.ok(bomb.length < 64 * 1024);
    await assert.rejects(readZip(bomb, () => true, 1024 * 1024), /unpacks to over/);
    assert.equal((await readZip(bomb, () => false, 1024 * 1024)).length, 0, "files it wasn't asked for aren't unpacked");
    assert.equal((await readZip(bomb))[0]!.data.length, 4 * 1024 * 1024);
  });

  it("reads CSV the way spreadsheets write it, and writes it back the same", () => {
    const rows = parseCsv('name,note\r\n"Jón, Jr.","says ""hi""\nthen leaves"\r\nÞóra,\r\n');
    assert.deepEqual(rows, [
      ["name", "note"],
      ["Jón, Jr.", 'says "hi"\nthen leaves'],
      ["Þóra", ""],
    ]);
    assert.deepEqual(parseCsv(toCsv(rows)), rows);
    assert.deepEqual(parseCsv("a;b\n1;2\n"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("turns JSON into a table and back, keeping numbers as numbers", () => {
    const rows = jsonToRows([{ a: 1, b: "x" }, { b: "y", c: { d: true } }]);
    assert.deepEqual(rows, [
      ["a", "b", "c"],
      ["1", "x", ""],
      ["", "y", '{"d":true}'],
    ]);
    assert.deepEqual(rowsToJson([["n", "zip"], ["42", "007"]]), [{ n: 42, zip: "007" }]);
  });

  it("writes an Excel workbook it (and Excel) can read back", async () => {
    const rows = [
      ["name", "age", "code"],
      ["Jón <&>", "42", "007"],
    ];
    assert.deepEqual(await xlsxToRows(await rowsToXlsx(rows)), rows);
    // Excel leaves blank rows out, and writes empty styled rows as <row/>.
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1"><v>1</v></c></row><row r="2" ht="20"/><row r="4"><c r="A4"><v>4</v></c></row></sheetData></worksheet>';
    const book = await makeZip([{ name: "xl/worksheets/sheet1.xml", data: text(sheet) }]);
    assert.deepEqual(await xlsxToRows(book), [
      ["a", "1"],
      ["", ""],
      ["", ""],
      ["4", ""],
    ]);
  });

  it("reads the text of a Word document, not its settings", async () => {
    const xml =
      '<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>Halló</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:t>&amp; B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body></w:document>';
    const docx = await makeZip([{ name: "word/document.xml", data: text(xml) }]);
    assert.equal(await docxToText(docx), "Halló\nA & B\tC\nD");
  });

  it("makes Markdown into HTML that can't run anything", () => {
    const html = markdownToHtml('# Hi <script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.com) <img src=x onerror=alert(1)>\n\n```\n<b>code</b>\n```');
    assert.ok(!/<script|<img|href="javascript/.test(html), html);
    assert.match(html, /<a href="https:\/\/example\.com">good<\/a>/);
    assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
  });

  it("writes YAML that keeps strings like yes and numbers-as-text quoted", () => {
    assert.equal(toYaml({ a: 1, b: "yes", c: "007", d: [1, { e: "x: y" }], f: {} }), 'a: 1\nb: "yes"\nc: "007"\nd:\n  - 1\n  -\n    e: "x: y"\nf: {}');
    assert.equal(toYaml(["- x", "@home", "-", "0x1F", ".inf", "plain words"]), '- "- x"\n- "@home"\n- "-"\n- "0x1F"\n- ".inf"\n- plain words');
  });

  it("writes a PDF whose cross-reference table points at its objects", () => {
    const pdf = textToPdf("Halló heimur (með svigum) \\ og meira.\n" + "orð ".repeat(2000), "Test");
    const s = Buffer.from(pdf).toString("latin1");
    assert.ok(s.startsWith("%PDF-1.4"));
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    assert.ok(s.slice(start).startsWith("xref"));
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    assert.match(s, /\(Halló heimur \\\(með svigum\\\) \\\\ og meira\.\) Tj/);
    assert.ok((s.match(/\/Type \/Page /g) ?? []).length > 1, "long text runs onto more pages");
  });

  it("round-trips Base64 and recognises what the bytes are", () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3);
    assert.deepEqual(fromBase64(toBase64(png)), png);
    assert.deepEqual(fromBase64(`data:image/png;base64,${toBase64(png)}`), png);
    assert.equal(sniff(png).ext, "png");
    assert.throws(() => fromBase64("!!!"), /isn't Base64/);
  });
});

describe("media the converter writes", () => {
  it("writes a WAV header for the sound it holds", () => {
    const wav = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 0, 0])], 48000);
    const v = new DataView(wav.buffer);
    assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), "RIFF");
    assert.equal(v.getUint16(22, true), 2);
    assert.equal(v.getUint32(24, true), 48000);
    assert.equal(v.getUint32(40, true), 12);
    assert.equal(v.getInt16(46, true), 16383);
  });

  it("checks Ogg pages with Ogg's own CRC, and lays out Opus headers", () => {
    assert.equal(oggCrc(text("123456789")), 0x89a1897f);
    const writer = new OggOpusWriter(2, 44100);
    for (let i = 0; i < 120; i++) writer.add(new Uint8Array(300), 960);
    const ogg = writer.finish();
    const pages: number[] = [];
    for (let i = 0; i + 4 < ogg.length; i++) if (ogg[i] === 0x4f && ogg[i + 1] === 0x67 && ogg[i + 2] === 0x67 && ogg[i + 3] === 0x53) pages.push(i);
    assert.equal(Buffer.from(ogg.subarray(pages[0]! + 28, pages[0]! + 36)).toString(), "OpusHead");
    // Every page's CRC is right (computed with the CRC field zeroed).
    pages.forEach((at, n) => {
      const end = pages[n + 1] ?? ogg.length;
      const page = ogg.slice(at, end);
      const crc = new DataView(page.buffer).getUint32(22, true);
      page.fill(0, 22, 26);
      assert.equal(oggCrc(page), crc, `page ${n}`);
    });
    const last = ogg.subarray(pages.at(-1)!);
    assert.equal(last[5]! & 0x04, 0x04, "the last page ends the stream");
    assert.equal(new DataView(last.buffer, last.byteOffset).getUint32(6, true), 312 + 120 * 960);
  });

  it("writes a looping GIF and an icon of PNGs", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(200);
    const gif = encodeGif([{ rgba, delay: 10 }, { rgba, delay: 10 }], 4, 4);
    assert.equal(Buffer.from(gif.subarray(0, 6)).toString(), "GIF89a");
    assert.ok(Buffer.from(gif).includes(Buffer.from("NETSCAPE2.0")));
    assert.equal(gif.at(-1), 0x3b);
    const ico = encodeIco([
      { size: 16, png: Uint8Array.of(0x89, 0x50) },
      { size: 256, png: Uint8Array.of(0x89, 0x50, 0x4e) },
    ]);
    const v = new DataView(ico.buffer);
    assert.equal(v.getUint16(4, true), 2);
    assert.equal(ico[6 + 16], 0, "256 is written as 0");
    assert.equal(v.getUint32(6 + 16 + 12, true), 6 + 32 + 2);
  });
});
