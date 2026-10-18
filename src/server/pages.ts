import { relativeTime } from "../shared/duration.ts";
import type { AuthRequest, Client, OwnerProfile, Scope } from "./oauth.ts";

/**
 * The few pages Cardboard renders on the server: signing in, saying yes or no
 * to an app, and errors. No JavaScript, strict CSP, and every value escaped.
 */

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true" class="page-logo"><path class="box-face" d="M8 20 32 8l24 12v26L32 58 8 46z"/><path class="box-line" d="M8 20l24 12 24-12M32 32v26"/><path class="box-tape" d="M20 14l24 12v9"/><path class="box-line" d="M8 20 32 8l24 12v26L32 58 8 46z"/></svg>`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="referrer" content="same-origin" />
<title>${esc(title)} · Cardboard</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<main class="auth-page">
<section class="card stack auth-card">
<div class="row">${LOGO}<span class="auth-brand">Cardboard</span></div>
${body}
</section>
</main>
</body>
</html>`;
}

export function loginPage(options: { returnTo: string; appName?: string; error?: string }): string {
  return layout(
    "Sign in",
    `<h1>Open your Cardboard</h1>
<p class="muted">${options.appName ? `${esc(options.appName)} wants to connect. First, prove this is your Cardboard.` : "Sign in with your owner token."}</p>
${options.error ? `<div class="error">${esc(options.error)}</div>` : ""}
<form method="post" action="/oauth/login" class="stack">
<input type="hidden" name="return_to" value="${esc(options.returnTo)}" />
<input type="text" name="username" value="Cardboard owner" autocomplete="username" hidden />
<label class="field">Owner token<input type="password" name="token" autocomplete="current-password" placeholder="cbo_…" required autofocus /></label>
<button type="submit">Sign in</button>
</form>
<p class="muted small">Your password manager can remember it. This browser stays signed in for 30 days.</p>`,
  );
}

const PERMISSIONS: Record<Scope, (ctx: { profile: OwnerProfile; boxName: string | null }) => [string, string] | null> = {
  openid: () => [
    "Recognise you when you come back",
    "With a private ID made only for this app, so it can't compare notes with other apps about you.",
  ],
  profile: ({ profile }) => ["See your name", profile.name ? `“${profile.name}”` : "You haven't set one, so it gets nothing."],
  email: ({ profile }) => ["See your email address", profile.email ?? "You haven't set one, so it gets nothing."],
  box: ({ boxName }) => [
    "Keep its data about you in your Cardboard",
    `${boxName ? `In the box “${boxName}”.` : "In a box of its own."} Not in its own database. You can look inside, take it with you, or shred it whenever you like.`,
  ],
  offline_access: () => null,
};

export function consentPage(options: {
  request: AuthRequest;
  profile: OwnerProfile;
  boxName: string | null;
  csrf: string;
  now: number;
}): string {
  const { request, profile, boxName, csrf, now } = options;
  const { client } = request;
  const destination = destinationOf(request.redirectUri);
  const permissions = request.scopes
    .map((scope) => PERMISSIONS[scope]({ profile, boxName }))
    .filter((p): p is [string, string] => p !== null)
    .map(([title, detail]) => `<li><strong>${esc(title)}</strong><div class="muted small">${esc(detail)}</div></li>`)
    .join("\n");
  const hidden = {
    client_id: client.id,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    nonce: request.nonce,
    csrf,
  };
  return layout(
    `Connect ${client.name}`,
    `<h1>Let <span class="mono">${esc(client.name)}</span> in?</h1>
<p class="muted">It's asking to:</p>
<ul class="list perms">${permissions}</ul>
<p class="small">It stays connected until you disconnect it from your Cardboard, or until it goes unused for 30 days.</p>
${unverified(client, now)}
<p class="small muted">After you choose, you'll go back to <strong>${esc(destination)}</strong>.</p>
<form method="post" action="/oauth/authorize" class="row">
${Object.entries(hidden)
  .filter(([, v]) => v !== null && v !== undefined)
  .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)
  .join("\n")}
<button type="submit" name="decision" value="allow">Let it in</button>
<button type="submit" name="decision" value="deny" class="secondary">No thanks</button>
</form>`,
  );
}

function unverified(client: Client, now: number): string {
  if (client.registeredBy !== "self") return "";
  return `<div class="insight warn"><div class="title">This app registered itself ${esc(relativeTime(client.createdAt, now))}</div><div class="detail">Only continue if you just clicked “Sign in with Cardboard” on ${esc(client.clientUri ? destinationOf(client.clientUri) : "its site")}.</div></div>`;
}

export function errorPage(message: string, hint?: string): string {
  return layout("Can't continue", `<h1>Can't continue</h1><div class="error">${esc(message)}</div>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}`);
}

export function donePage(message: string): string {
  return layout("Done", `<h1>${esc(message)}</h1><p class="muted">You can close this tab.</p>`);
}

function destinationOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || url.protocol.replace(/:$/, "");
  } catch {
    return uri;
  }
}
