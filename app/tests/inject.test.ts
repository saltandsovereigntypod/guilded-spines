import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  STORE_PLACEHOLDER,
  imageFileName,
  imageKeyFromFileName,
  pageWithStore,
  replyScript,
  scriptJson,
} from '../src/inject.ts';

const page = readFileSync(new URL('../assets/web/gilded-spines.html', import.meta.url), 'utf8');

test('the built page holds exactly one store placeholder', () => {
  assert.equal(page.split(STORE_PLACEHOLDER).length, 2);
});

test('the built page needs no connection: fonts are embedded, nothing loads from Google', () => {
  assert.ok(!page.includes('fonts.googleapis.com'));
  assert.ok(!page.includes('fonts.gstatic.com'));
  assert.ok(page.includes('url(data:font/woff2;base64,'));
  for (const family of ['Cinzel', 'EB Garamond', 'Spectral']) assert.ok(page.includes(`font-family: '${family}'`), family);
});

test('the built page uses the app bridge for the shelf, images and exports', () => {
  assert.ok(page.includes('window.__GILDED_NATIVE__ = {'));
  assert.ok(page.includes('window.__GILDED_IMAGES__ = {'));
  assert.ok(page.includes('var IMGDB = window.__GILDED_IMAGES__ ||'));
  assert.ok(page.includes('if(name === "downloads" && NATIVE)'));
  // No service worker or web manifest inside the app.
  assert.ok(!page.includes('serviceWorker.register'));
  assert.ok(!page.includes('rel="manifest"'));
});

test('first run: the placeholder becomes null and the page seeds itself', () => {
  const out = pageWithStore(page, null);
  assert.ok(out.includes('store: null,'));
  assert.ok(!out.includes(STORE_PLACEHOLDER));
});

test('a saved shelf goes in whole, even with characters that would end a script or a replace pattern', () => {
  const store = {
    books: { a: { title: 'The </script><script>alert(1)</script> $& $1 $$ Book', author: 'x y' } },
    settings: {},
  };
  const out = pageWithStore(`<script>var s = ${STORE_PLACEHOLDER};</script>`, JSON.stringify(store));
  assert.ok(!out.slice(8, -9).includes('</script>'));
  const js = out.slice('<script>var s = '.length, -';</script>'.length);
  assert.deepEqual(JSON.parse(js), store);
});

test('a damaged placeholder is reported rather than silently losing the shelf', () => {
  assert.throws(() => pageWithStore('<p>no placeholder</p>', '{}'), /placeholder/);
});

test('scriptJson round-trips', () => {
  for (const v of [null, 1, 'a<b', [' '], { k: 'data:image/jpeg;base64,AAAA' }]) {
    assert.deepEqual(JSON.parse(scriptJson(v)), v);
  }
  assert.equal(scriptJson(undefined), 'null');
});

test('replies call back into the page', () => {
  assert.equal(replyScript(7, true, ['a:cover']), 'window.__gsReply && window.__gsReply(7, true, ["a:cover"]);true;');
  assert.equal(replyScript(8, false, 'No'), 'window.__gsReply && window.__gsReply(8, false, "No");true;');
});

test('image keys survive the trip through file names', () => {
  for (const key of ['abc123:cover', 'id-lz9:spine', 'odd/key with spaces:cover']) {
    const name = imageFileName(key);
    assert.ok(!name.includes('/') && !name.includes(':'));
    assert.equal(imageKeyFromFileName(name), key);
  }
  assert.equal(imageKeyFromFileName('.DS_Store'), null);
  assert.equal(imageKeyFromFileName('%E0%A4%A.txt'), null);
});
