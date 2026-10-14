/**
 * Spots sensitive data inside JSON values so Cardboard can tell you about it
 * (and, if you ask it to, refuse to store secrets). Findings only ever carry
 * the *path* and the *kind*, never the matched value itself.
 *
 * Every pattern uses bounded quantifiers so a hostile string can't make the
 * scanner backtrack for seconds.
 */

export type SensitiveKind =
  | "private-key"
  | "api-key"
  | "jwt"
  | "password"
  | "card-number"
  | "iban"
  | "kennitala"
  | "ssn"
  | "email"
  | "phone";

/** Kinds that are credentials, not just personal data. `secrets: "block"` refuses these. */
export const SECRET_KINDS: ReadonlySet<SensitiveKind> = new Set(["private-key", "api-key", "jwt", "password"]);

export interface Finding {
  kind: SensitiveKind;
  path: string;
  /** e.g. "OpenAI" for an OpenAI key. */
  what?: string;
}

const MAX_STRING = 16 * 1024;
const MAX_STRINGS = 5000;
const MAX_DEPTH = 24;
const MAX_FINDINGS = 50;

const PROVIDER_KEYS: Array<[string, RegExp]> = [
  ["Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,300}/],
  ["OpenAI", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300}/],
  ["GitHub", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})/],
  ["AWS", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Stripe", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}/],
  ["Slack", /\bxox[abposr]-[A-Za-z0-9-]{10,255}/],
  ["Google", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Cardboard", /\bcb[to]_[A-Za-z0-9_-]{40,60}/],
];

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]{1,20} ){0,3}PRIVATE KEY-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,1024}/;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const KENNITALA = /(?<!\d)(\d{6})-?(\d{4})(?!\d)/g;
const SSN = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/;
const PHONE = /(?<![\w+])\+[1-9](?:[ ()-]{0,2}\d){6,14}(?!\d)/;

/** Password hashes are the *right* way to store passwords, so they don't count. */
const PASSWORD_HASH = /^\$(?:2[abxy]?|argon2(?:id|i|d)|scrypt|pbkdf2(?:-sha\d+)?|[156])\$/;

function fieldHint(field: string): "password" | "secret" | "phone" | null {
  const f = field.toLowerCase().replace(/[_\-\s]/g, "");
  if (/^(password|passwd|pwd|pass|passphrase|pin|lykilord)$/.test(f)) return "password";
  if (/(secret|apikey|accesstoken|refreshtoken|authtoken|bearertoken|privatekey|clientsecret)$/.test(f)) return "secret";
  if (/^(phone|phonenumber|mobile|tel|telephone|simi|gsm)$/.test(f)) return "phone";
  return null;
}

export function scan(value: unknown): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let strings = 0;

  const add = (kind: SensitiveKind, path: string, what?: string) => {
    const id = `${kind}@${path}`;
    if (seen.has(id) || findings.length >= MAX_FINDINGS) return;
    seen.add(id);
    findings.push(what ? { kind, path, what } : { kind, path });
  };

  const visit = (node: unknown, path: string, field: string | null, depth: number) => {
    if (depth > MAX_DEPTH || strings > MAX_STRINGS || findings.length >= MAX_FINDINGS) return;
    if (typeof node === "string") {
      strings++;
      scanString(node.length > MAX_STRING ? node.slice(0, MAX_STRING) : node, path || "(value)", field, add);
    } else if (typeof node === "number" && field && fieldHint(field) === "phone" && String(node).length >= 7) {
      add("phone", path);
    } else if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${path}[${i}]`, field, depth + 1));
    } else if (node && typeof node === "object") {
      for (const [k, child] of Object.entries(node)) {
        visit(child, path ? `${path}.${k}` : k, k, depth + 1);
      }
    }
  };

  visit(value, "", null, 0);
  return findings;
}

function scanString(
  s: string,
  path: string,
  field: string | null,
  add: (kind: SensitiveKind, path: string, what?: string) => void,
) {
  // Specific provider keys first, so they win over the generic field-name hint.
  if (s.length >= 8) {
    for (const [provider, pattern] of PROVIDER_KEYS) {
      if (pattern.test(s)) {
        add("api-key", path, provider);
        break;
      }
    }
  }
  const hint = field ? fieldHint(field) : null;
  if (hint === "password" && s.length >= 4 && !PASSWORD_HASH.test(s)) add("password", path);
  if (hint === "secret" && s.length >= 8) add("api-key", path);
  if (hint === "phone" && (s.match(/\d/g)?.length ?? 0) >= 7) add("phone", path);

  if (s.length < 8) return;
  if (s.includes("PRIVATE KEY") && PRIVATE_KEY.test(s)) add("private-key", path);
  if (s.includes("eyJ") && JWT.test(s)) add("jwt", path);
  if (s.includes("@") && EMAIL.test(s)) add("email", path);
  if (s.includes("+") && PHONE.test(s)) add("phone", path);
  if (SSN.test(s)) add("ssn", path);

  if (/\d{4}/.test(s) || /\d[ -]\d/.test(s)) {
    for (const m of s.matchAll(CARD)) {
      if (luhn(m[0].replace(/\D/g, ""))) {
        add("card-number", path);
        break;
      }
    }
    for (const m of s.matchAll(KENNITALA)) {
      if (validKennitala(m[1]! + m[2]!)) {
        add("kennitala", path);
        break;
      }
    }
  }
  if (/[A-Z]{2}\d{2}/.test(s)) {
    for (const m of s.matchAll(IBAN)) {
      if (validIban(m[0])) {
        add("iban", path);
        break;
      }
    }
  }
}

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  if (!/^[2-6]/.test(digits)) return false; // Visa, Mastercard, Amex, Discover, JCB, UnionPay…
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function validIban(raw: string): boolean {
  const iban = raw.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Icelandic national ID: DDMMYY + 2 digits + check digit + century digit. */
export function validKennitala(kt: string): boolean {
  if (!/^\d{10}$/.test(kt)) return false;
  let day = Number(kt.slice(0, 2));
  if (day > 40) day -= 40; // companies add 40 to the day
  const month = Number(kt.slice(2, 4));
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  if (!"890".includes(kt[9]!)) return false;
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(kt[i]), 0);
  const check = (11 - (sum % 11)) % 11;
  return check !== 10 && check === Number(kt[8]);
}

const NAMES: Record<SensitiveKind, [string, string]> = {
  "private-key": ["private key", "private keys"],
  "api-key": ["API key or secret", "API keys or secrets"],
  jwt: ["login token", "login tokens"],
  password: ["plain-text password", "plain-text passwords"],
  "card-number": ["card number", "card numbers"],
  iban: ["bank account number", "bank account numbers"],
  kennitala: ["kennitala", "kennitölur"],
  ssn: ["social security number", "social security numbers"],
  email: ["email address", "email addresses"],
  phone: ["phone number", "phone numbers"],
};

export function kindName(kind: SensitiveKind, count = 1): string {
  return NAMES[kind][count === 1 ? 0 : 1];
}

/** "12 email addresses, 1 API key or secret and 3 phone numbers" */
export function describeCounts(counts: Partial<Record<SensitiveKind, number>>): string {
  const parts = (Object.entries(counts) as Array<[SensitiveKind, number]>)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => Number(SECRET_KINDS.has(b)) - Number(SECRET_KINDS.has(a)))
    .map(([kind, n]) => `${n} ${kindName(kind, n)}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The friendly notice returned to an app right after it stores something sensitive. */
export function notice(f: Finding): string {
  switch (f.kind) {
    case "password":
      return `"${f.path}" looks like a plain-text password. Store a hash instead (argon2 or bcrypt).`;
    case "api-key":
      return `"${f.path}" looks like ${f.what ? `${/^[aeiou]/i.test(f.what) ? "an" : "a"} ${f.what} key` : "an API key or secret"}. Any tape that can read this box can use it.`;
    case "private-key":
      return `"${f.path}" contains a private key. Anyone who can read this box could impersonate its owner.`;
    case "jwt":
      return `"${f.path}" holds a login token (JWT). If it is long-lived, anyone who reads it can log in as that user.`;
    default:
      return `"${f.path}" contains ${/^[aeiou]/i.test(kindName(f.kind)) ? "an" : "a"} ${kindName(f.kind)}. Cardboard is tracking it in this box's inventory.`;
  }
}
