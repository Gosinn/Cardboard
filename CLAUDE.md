# Cardboard

A personal encrypted backend: each app gets a box, opened with a tape.

## Commands
- `npm test`: all tests (node:test, runs .ts directly). `npm run typecheck`: tsc. Run both before committing.
- `npm start`: dev server on 127.0.0.1:8787 (data in ./cardboard-data, gitignored).
- `npm run build`: compiles src/ to dist/ (what other apps install via git).

## Layout
- `src/server/vault.ts`: the only code that reads or writes box data. Everything is encrypted there.
- `src/server/api.ts`: auth, scopes and every operation (pure: request in, response out, so the shake test can call it).
- `src/server/http.ts`: Node HTTP server, static dashboard, SSE watch.
- `src/server/docks.ts` + `customs.ts`: anonymous app-to-app parcels. Apps only ever see per-dock pseudonyms; every parcel passes customs before it's stored.
- `src/server/shake.ts`: the self-attack test. Add a check whenever you add a new protection.
- `src/sdk/index.ts`: browser-safe SDK; must not import node: modules.
- `src/cli.ts`: the `cardboard` command. `public/`: the dashboard (vanilla JS, no build).

## Rules
- Zero runtime dependencies. Node built-ins only (node:sqlite, node:crypto).
- Never write key names, values, IPs or secrets in plain text: not to disk, not to logs, not into URLs.
- Never let an app see another app's name, box id or tape id through a dock. The owner sees everything.
- Errors use `fail(code, status, reason, hint)` with a plain-English reason and a hint that says how to fix it.
- Code is TypeScript with erasable syntax only (no enums, no parameter properties) and imports use `.ts` extensions.
- Dashboard code inserts app data with textContent only, never innerHTML.
