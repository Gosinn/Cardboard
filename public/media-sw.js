// Cardboard's media helper: lets a video or song in your personal box play
// (and a big file download) a piece at a time, without the whole file in
// memory. It never holds a key. For each piece, it asks the dashboard page
// that offered the file, which fetches the sealed parts and opens them.
//
// It answers only /media/<token>/… addresses, and only while the page that
// made the token is open (tokens live in that page's memory). Its responses
// are sandboxed, so a file can never run as a page here.
//
// It also catches what you share to Cardboard from other apps (Android's
// share sheet), keeps it on this phone, and hands it to the dashboard, which
// seals it and sends it to your other devices. It never reaches the server
// unsealed.

const PIECE = 2 * 1024 * 1024;
const SAFE_TYPE = /^(audio|video)\/[\w.+-]+$|^image\/(png|jpeg|gif|webp|avif|bmp)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === "POST" && url.pathname === "/share") return event.respondWith(takeShare(event.request));
  if (!url.pathname.startsWith("/media/")) return;
  event.respondWith(serve(event, url).catch((err) => new Response(String(err?.message || err), { status: 404, headers: { "content-type": "text/plain" } })));
});

/**
 * Asks the dashboard page holding `token` for something; it answers through a
 * MessageChannel. Every open dashboard page is asked (a download comes from a
 * hidden frame, not the page itself); only the one holding the token answers.
 */
async function ask(message) {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return Promise.any(
    pages.map(
      (page) =>
        new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => reject(new Error("The page holding this file didn't answer.")), 120_000);
          channel.port1.onmessage = (e) => {
            clearTimeout(timer);
            if (e.data && !e.data.error) resolve(e.data);
            else reject(new Error(e.data?.error || "Not this page."));
          };
          page.postMessage({ cardboard: "media", ...message }, [channel.port2]);
        }),
    ),
  ).catch((err) => {
    throw new Error(err.errors?.[0]?.message || "This file isn't open in Cardboard any more. Open it again.");
  });
}

async function serve(event, url) {
  const token = url.pathname.split("/")[2];
  const info = await ask({ type: "info", token });
  const download = url.searchParams.has("download");
  const headers = {
    "content-type": !download && SAFE_TYPE.test(info.type) ? info.type : "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`;

  const range = event.request.headers.get("range");
  if (range && !download && typeof info.size === "number") {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] !== "" ? Number(m[1]) : NaN;
    let end = m && m[2] !== "" ? Number(m[2]) : NaN;
    if (m && m[1] === "" && m[2] !== "") {
      start = Math.max(0, info.size - Number(m[2])); // the last N bytes
      end = info.size - 1;
    }
    if (!(start >= 0 && start < info.size) || (end < start)) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}` } });
    }
    // An open-ended range ("from here on") gets a piece at a time; players ask for the next.
    end = Math.min(Number.isNaN(end) ? start + PIECE - 1 : end, start + 4 * PIECE - 1, info.size - 1);
    const { bytes } = await ask({ type: "read", token, start, end });
    return new Response(bytes, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(bytes.byteLength) } });
  }

  // The whole file, as a stream: read in order, checked against its hash at the end.
  const { stream } = await ask({ type: "open", token });
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await ask({ type: "next", token, stream });
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.bytes));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      ask({ type: "close", token, stream }).catch(() => {});
    },
  });
  if (typeof info.size === "number") headers["content-length"] = String(info.size);
  return new Response(body, { status: 200, headers });
}

/** Something shared to Cardboard from another app: kept on this device (IndexedDB) until the dashboard sends it. */
async function takeShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => typeof f !== "string" && f.size > 0);
    const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).join("\n");
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("cardboard-share", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("pending");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.objectStore("pending").put({ text, files, at: Date.now() }, "share");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return Response.redirect("/#/send", 303);
  } catch {
    return Response.redirect("/#/send?failed", 303);
  }
}
