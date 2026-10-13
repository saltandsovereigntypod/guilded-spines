// Pure helpers for putting values into the page. Kept free of React Native so
// the tests can run them under plain Node.

export const STORE_PLACEHOLDER = '/*__GILDED_STORE__*/null';

/** JSON that is safe inside an inline <script> and as JavaScript source. */
export function scriptJson(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value);
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The page with the saved shelf put in place of its placeholder. `storeJson` is
 * the saved file's text, or null on the first run (the page then seeds itself).
 */
export function pageWithStore(html: string, storeJson: string | null): string {
  const at = html.indexOf(STORE_PLACEHOLDER);
  if (at === -1) throw new Error('The page has no store placeholder; rebuild it with build.py.');
  let value: unknown = null;
  if (storeJson) value = JSON.parse(storeJson);
  // Spliced by hand: String.replace would read "$&" and friends inside the shelf.
  return html.slice(0, at) + scriptJson(value) + html.slice(at + STORE_PLACEHOLDER.length);
}

/** JavaScript that answers request `id` from the page. */
export function replyScript(id: number, ok: boolean, value: unknown): string {
  return `window.__gsReply && window.__gsReply(${Number(id)}, ${ok ? 'true' : 'false'}, ${scriptJson(value)});true;`;
}

/** Image keys ("<bookId>:cover") as file names, and back. */
export function imageFileName(key: string): string {
  return encodeURIComponent(key) + '.txt';
}
export function imageKeyFromFileName(name: string): string | null {
  if (!name.endsWith('.txt')) return null;
  try {
    return decodeURIComponent(name.slice(0, -4));
  } catch {
    return null;
  }
}
