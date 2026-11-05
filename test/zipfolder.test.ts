import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readZip, zipFolder } from "../src/client/formats.ts";

describe("a folder as one .zip", () => {
  it("keeps every file and folder, squeezes what it can, and opens anywhere", async () => {
    const text = new TextEncoder().encode("hello ".repeat(5000));
    const random = crypto.getRandomValues(new Uint8Array(40_000));
    const zip = await zipFolder(
      [
        { path: "Hooder/readme.txt", file: new Blob([text]) },
        { path: "Hooder/bin/hooder", file: new Blob([random]) },
        { path: "Hooder/lib/émoji ✓.so", file: new Blob([new Uint8Array(3)]) },
        { path: "Hooder/empty", file: new Blob([]) },
      ],
      "Hooder",
    );
    assert.equal(zip.name, "Hooder.zip");
    assert.equal(zip.type, "application/zip");
    assert.ok(zip.size < text.length + random.length, "text gets squeezed");
    const back = await readZip(new Uint8Array(await zip.arrayBuffer()));
    const byName = Object.fromEntries(back.map((e) => [e.name, e.data]));
    assert.deepEqual(Object.keys(byName).sort(), ["Hooder/bin/hooder", "Hooder/empty", "Hooder/lib/émoji ✓.so", "Hooder/readme.txt"]);
    assert.deepEqual(byName["Hooder/readme.txt"], text);
    assert.deepEqual(byName["Hooder/bin/hooder"], random);
    assert.equal(byName["Hooder/empty"]!.length, 0);
  });
});
