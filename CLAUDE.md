# Cardboard

A personal, end-to-end encrypted backend: each app gets a box, opened with a tape. Many people can share one server; the server can't read any of it.

## Commands
- `npm test`: all tests (node:test, runs .ts directly). `npm run typecheck`: tsc. Run both before committing.
- `npm start`: dev server on 127.0.0.1:8787 (data in ./cardboard-data, gitignored). Then `node src/cli.ts signup`.
- `npm run build`: compiles src/ to dist/ (what other apps install via git).

## Layout
- `src/client/`: the key-holding side (WebCrypto, browser-safe): `crypto.ts` (seal/open, sealTo, Shamir, human codes), `keys.ts` (key hierarchy), `account.ts` (sign up, pairing, recovery, and everything a device does: boxes, tapes, docks, apps, log, insights, search), `rpc.ts`, `device.ts`.
- `src/sdk/index.ts`: the app SDK; seals items and parcels before they leave the app, runs customs at both ends. `src/sdk/login.ts`: Sign in with Cardboard for apps.
- `src/shared/`: pure, browser-safe modules used by both sides: contexts (every seal's authenticated context), detect, customs, query, labels, blast, insights, activity (log sentences).
- `src/server/`: the blind server. `api.ts` (every operation; the token type decides who you are: cbt_ tape, cbd_ device, cbh_ host, none = public), `accounts.ts` (people, devices, recovery copies, pairing, invites), `vault.ts` (sealed items, history, undo, rewind, quotas), `tapes.ts`, `docks.ts`, `audit.ts`, `oauth.ts` + `oauth-http.ts` (consent happens in the dashboard), `http.ts` (also serves src/client|shared|sdk to the dashboard, types stripped), `shake.ts` (self-attack through the real API and client code).
- `src/mcp.ts`: the local MCP server (`cardboard mcp <name>`), holding tapes only for shared boxes. `src/node/store.ts`: the CLI's device file.
- `src/cli.ts`: the `cardboard` command. `public/`: the dashboard (vanilla JS modules, no build); `device.js` keeps a non-extractable device key in IndexedDB.

## Rules
- Zero runtime dependencies. Node built-ins and WebCrypto only.
- The server must never be able to open anything a person stored. Anything a person wrote (values, key names, box/dock names, labels, profiles) reaches the server sealed by a key it doesn't have. If a feature needs content, it runs on the device or in the SDK.
- Every seal uses a context from `src/shared/contexts.ts` that binds it to where it lives (box id, item index…). Never change an existing context.
- Never write tokens, keys, IPs or plaintext names to disk, logs or URLs. The server stores only hashes of tokens; the key half of a tape never leaves the app.
- Never let an app see another app's name, box id or tape id through a dock. Another account's box must look exactly like no box.
- `src/client`, `src/shared` and `src/sdk` must not import node: modules (they run in browsers). Use erasable TypeScript only (no enums, no parameter properties) and `.ts` import extensions.
- Errors use `fail(code, status, reason, hint)` with a plain-English reason and a hint that says how to fix it.
- Dashboard code inserts app data with textContent only, never innerHTML.
- The shake test gets a check for every new protection.
