import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, makeZip, readZip } from "../src/client/formats.ts";
import { repairFile } from "../src/client/repair.ts";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(bytes(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

describe("fixing broken files", () => {
  it("names a file for what it really is", async () => {
    const png = cat(PNG, pngChunk("IHDR", new Uint8Array(13)), pngChunk("IEND", new Uint8Array()));
    const r = await repairFile("holiday.jpg", png);
    assert.equal(r.name, "holiday (fixed).png");
    assert.match(r.fixes[0]!, /really a PNG picture.*\.jpg/);
    assert.deepEqual(r.data, png, "the bytes stay as they were");
    const fine = await repairFile("holiday.png", png);
    assert.equal(fine.data, null);
    assert.equal(fine.name, "holiday.png");
    assert.equal((await repairFile("IMG_0001.jpeg", Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 1, 0xff, 0xd9))).data, null, ".jpeg is a JPEG too");
  });

  it("closes off a picture or GIF that was cut short, and puts PNG checksums right", async () => {
    const cut = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 9);
    const r = await repairFile("cut.jpg", cut);
    assert.deepEqual([...r.data!.slice(-2)], [0xff, 0xd9]);
    assert.match(r.fixes[0]!, /cut off part way/);
    const png = cat(PNG, pngChunk("IHDR", new Uint8Array(13)), pngChunk("IDAT", Uint8Array.of(1, 2, 3)));
    png[png.length - 1] = png[png.length - 1]! ^ 0xff; // a wrong checksum, and no end
    const p = await repairFile("x.png", png);
    assert.equal(p.fixes.length, 2);
    assert.ok(text(p.data!).includes("IEND"));
    const again = await repairFile("x.png", p.data!);
    assert.deepEqual(again.notes, ["The picture checks out."]);
    assert.equal((await repairFile("a.gif", bytes("GIF89a\x01\x00\x01\x00"))).data!.at(-1), 0x3b);
  });

  it("counts a cut-off recording's length again", async () => {
    const wav = new Uint8Array(44 + 100);
    wav.set(bytes("RIFF"), 0);
    wav.set(bytes("WAVEfmt "), 8);
    new DataView(wav.buffer).setUint32(16, 16, true);
    wav.set(bytes("data"), 36);
    const r = await repairFile("voice.wav", wav);
    const v = new DataView(r.data!.buffer);
    assert.equal(v.getUint32(4, true), wav.length - 8);
    assert.equal(v.getUint32(40, true), 100);
  });

  it("rebuilds a zip (or a Word document) cut off at the end, from the files that are whole", async () => {
    const zip = await makeZip([
      { name: "word/document.xml", data: bytes("<w:document>hello</w:document>".repeat(20)) },
      { name: "notes.txt", data: bytes("a".repeat(500)) },
      { name: "big.bin", data: crypto.getRandomValues(new Uint8Array(3000)) },
    ]);
    const cut = zip.subarray(0, zip.length - 1000);
    const r = await repairFile("report.docx", cut);
    assert.match(r.fixes[0]!, /missing \(the file was cut off\).*2 files.*1 couldn't be saved: big\.bin/);
    assert.deepEqual(
      (await readZip(r.data!)).map((e) => e.name),
      ["word/document.xml", "notes.txt"],
    );
  });

  it("turns old-encoding and scrambled text back into proper letters", async () => {
    const old = await repairFile("names.csv", Uint8Array.of(0x4a, 0xf3, 0x6e, 0x2c, 0xde, 0xf3, 0x72, 0x61)); // "Jón,Þóra" in Windows-1252
    assert.equal(text(old.data!), "Jón,Þóra");
    const scrambled = await repairFile("note.txt", new TextEncoder().encode("CafÃ© crÃ¨me â€” Ã¾etta"));
    assert.equal(text(scrambled.data!), "Café crème — þetta");
    assert.equal((await repairFile("ok.txt", new TextEncoder().encode("Café, fine"))).data, null);
  });

  it("takes comments and stray commas out of JSON", async () => {
    const r = await repairFile("settings.json", new TextEncoder().encode('{\n  // the name\n  "name": "Jón // not a comment",\n  "list": [1, 2,],\n}'));
    assert.deepEqual(JSON.parse(text(r.data!)), { name: "Jón // not a comment", list: [1, 2] });
  });

  it("rebuilds a PDF's table of contents when it points to the wrong places", async () => {
    const body = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
    const broken = `${body}xref\n0 3\n0000000000 65535 f \n0000000999 00000 n \n0000000888 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
    const r = await repairFile("form.pdf", bytes(broken));
    const s = text(r.data!);
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    assert.ok(s.slice(start).startsWith("xref"));
    const rows = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.ok(s.slice(rows[0]).startsWith("1 0 obj") && s.slice(rows[1]).startsWith("2 0 obj"), "each entry points at its object");
    assert.deepEqual((await repairFile("form.pdf", r.data!)).notes, ["The PDF's table of contents checks out."]);
  });
});
