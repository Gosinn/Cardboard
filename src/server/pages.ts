/**
 * The only page Cardboard renders on the server: "can't continue". Saying yes
 * to an app happens in your dashboard, because that's where your keys are.
 * No JavaScript, strict CSP, and every value escaped.
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

export function errorPage(message: string, hint?: string): string {
  return layout("Can't continue", `<h1>Can't continue</h1><div class="error">${esc(message)}</div>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}`);
}
