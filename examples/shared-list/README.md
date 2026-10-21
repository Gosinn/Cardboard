# Shared list: a starter app with no database

A family list (shopping, wishes, chores) that lives in each person's own Cardboard.
Sign in with Cardboard, share the box with family, and you all see changes live.
Every change can be undone. This app stores nothing itself.

## Run it (about 5 minutes)

1. In your Cardboard: **Apps → Add “Sign in with Cardboard” to an app**. Name it
   "Shared list", address `http://localhost:5173/callback`, leave "has its own server"
   unticked. Copy the client id (`cbc_…`).
2. In the Cardboard folder:

   ```
   node examples/shared-list/serve.ts https://your-cardboard-address cbc_yourClientId
   ```

3. Open http://localhost:5173 and press **Sign in with Cardboard**.
4. To use it together: in your Cardboard open the list's box, then
   **People → Share with someone**. Or invite a friend straight into the app:
   **Apps → Invite a friend to Shared list** (put the app's real address in the app's
   settings first if it's online somewhere).

## Make it yours

`app.js` is the whole app. Ask your AI assistant to change it, and point it at
[`docs/FOR-AI.md`](../../docs/FOR-AI.md) first: those rules keep your friends' data
sealed. To put it online, copy `index.html`, `app.js` and the SDK (`npm run build`
makes `dist/`) to any static host (GitHub Pages, Cloudflare Pages), and add the new
address to the app in your Cardboard.
