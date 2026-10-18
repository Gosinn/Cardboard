/**
 * Box and dock names are what apps use in their code ("lore", "shopping-list"),
 * so they're lowercase letters, numbers and dashes. People can type anything:
 * this turns "LORE" into "lore" and "Innkaupalisti fjölskyldunnar" into
 * "innkaupalisti-fjolskyldunnar".
 */

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Letters that don't break down into a plain letter plus an accent.
const SPELLED: Record<string, string> = { þ: "th", ð: "d", æ: "ae", ø: "o", œ: "oe", ß: "ss", ł: "l", đ: "d" };

/** A usable name from whatever someone typed, or "" if there's nothing to make one from. */
export function toName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[þðæøœßłđ]/g, (c) => SPELLED[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}
