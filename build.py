#!/usr/bin/env python3
"""
Build a standalone index.html from the Artifact source.

The file in artifact/gilded-spines.html is the version published as a Claude
Artifact: it has no <!doctype>/<html>/<head>/<body> (the Artifact runtime adds
those) and it persists through the Artifact `db` and `assets` capabilities.

This script wraps that source in a full HTML document and prepends a small
localStorage shim so the same app runs anywhere — GitHub Pages, a file:// open,
any static host — seeded with the library in src/library.seed.json and, when it
is present, the Oracle's catalogue in src/oracle-catalog.json.

    python3 build.py

Output: index.html
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).parent
SOURCE = ROOT / "artifact" / "gilded-spines.html"
SEED = ROOT / "src" / "library.seed.json"
ORACLE = ROOT / "src" / "oracle-catalog.json"
OUT = ROOT / "index.html"

SHIM = """
<script>
/* ------------------------------------------------------------------
   Standalone persistence shim.

   Inside a Claude Artifact, window.claude.use("db") hands the app a
   shared, account-backed document store. Outside one, that doesn't
   exist, so we stand up a minimal local equivalent over localStorage
   with the same surface the app uses: doc(path).set/.delete/.onSnapshot
   and collection("books").onSnapshot.

   Data lives in this browser only. Clearing site data clears the shelf.
   ------------------------------------------------------------------ */
(function(){
  if(window.claude && window.claude.use) return;   // real runtime wins

  var KEY = "gilded-spines.library.v1";
  var SEED = window.__GILDED_SEED__ || {};

  function read(){
    try { return JSON.parse(localStorage.getItem(KEY)) || null; }
    catch(e){ return null; }
  }
  function write(s){
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch(e){ /* private mode, quota — the session still works in memory */ }
  }

  var store = read();
  if(!store){ store = { books: SEED, settings: {} }; write(store); }
  if(!store.books) store.books = {};
  if(!store.settings) store.settings = {};

  var bookListeners = [];
  var docListeners = {};   // path -> [fn]

  function snapOf(id, body){
    return {
      id: id,
      exists: !!body,
      data: function(){ return body; },
      metadata: { fromCache: true, hasPendingWrites: false }
    };
  }
  function pushBooks(){
    var docs = Object.keys(store.books).sort().map(function(id){
      return snapOf(id, store.books[id]);
    });
    var snap = {
      docs: docs, size: docs.length, empty: !docs.length,
      docChanges: function(){ return []; },
      metadata: { fromCache: true, hasPendingWrites: false }
    };
    bookListeners.forEach(function(fn){ try { fn(snap); } catch(e){} });
  }
  function pushDoc(path){
    (docListeners[path] || []).forEach(function(fn){
      try { fn(snapOf(path.split("/").pop(), bodyAt(path))); } catch(e){}
    });
  }
  function bodyAt(path){
    var parts = path.split("/");
    if(parts[0] === "books") return store.books[parts[1]];
    if(parts[0] === "settings") return store.settings[parts[1]];
    return undefined;
  }
  function setAt(path, data){
    var parts = path.split("/");
    if(parts[0] === "books") store.books[parts[1]] = data;
    else if(parts[0] === "settings") store.settings[parts[1]] = data;
    write(store);
  }
  function delAt(path){
    var parts = path.split("/");
    if(parts[0] === "books") delete store.books[parts[1]];
    else if(parts[0] === "settings") delete store.settings[parts[1]];
    write(store);
  }

  function docRef(path){
    return {
      id: path.split("/").pop(),
      path: path,
      get: function(){ return Promise.resolve(snapOf(this.id, bodyAt(path))); },
      set: function(data){
        setAt(path, JSON.parse(JSON.stringify(data)));
        pushDoc(path);
        if(path.indexOf("books/") === 0) pushBooks();
        return Promise.resolve();
      },
      update: function(data){ return this.set(Object.assign({}, bodyAt(path) || {}, data)); },
      delete: function(){
        delAt(path);
        pushDoc(path);
        if(path.indexOf("books/") === 0) pushBooks();
        return Promise.resolve();
      },
      acquire: function(){ return Promise.resolve({ acquired: true }); },
      onSnapshot: function(next){
        (docListeners[path] = docListeners[path] || []).push(next);
        setTimeout(function(){ next(snapOf(path.split("/").pop(), bodyAt(path))); }, 0);
        return function(){
          docListeners[path] = (docListeners[path] || []).filter(function(f){ return f !== next; });
        };
      },
      collection: function(sub){ return collectionRef(path + "/" + sub); }
    };
  }
  function collectionRef(path){
    return {
      path: path,
      doc: function(id){ return docRef(path + "/" + (id || ("id-" + Date.now().toString(36)))); },
      add: function(data){ var r = this.doc(); return r.set(data).then(function(){ return r; }); },
      where: function(){ return this; },
      orderBy: function(){ return this; },
      limit: function(){ return this; },
      get: function(){
        var docs = Object.keys(store.books).sort().map(function(id){ return snapOf(id, store.books[id]); });
        return Promise.resolve({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function(){ return []; } });
      },
      onSnapshot: function(next){
        if(path !== "books"){ setTimeout(function(){ next({ docs: [], size: 0, empty: true, docChanges: function(){ return []; } }); }, 0); return function(){}; }
        bookListeners.push(next);
        setTimeout(pushBooks, 0);
        return function(){ bookListeners = bookListeners.filter(function(f){ return f !== next; }); };
      }
    };
  }

  var localDb = { doc: docRef, collection: collectionRef };

  window.claude = {
    use: function(name){
      if(name === "db") return Promise.resolve(localDb);
      return Promise.resolve(null);   // no asset uploads outside the Artifact
    }
  };
})();
</script>
"""

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A candlelit book tracker — spines on a shelf, half-step ratings, and books that open to a two-page spread.">
<meta name="color-scheme" content="dark">
<style>
  html,body{margin:0}
  img{max-width:100%}
  [hidden]{display:none!important}
</style>
"""


def main():
    source = SOURCE.read_text(encoding="utf-8")
    seed = json.loads(SEED.read_text(encoding="utf-8"))

    seed_script = (
        "<script>window.__GILDED_SEED__ = "
        + json.dumps(seed, ensure_ascii=False, separators=(",", ":"))
        + ";</script>\n"
    )

    # The Oracle's catalogue rides along the same way. It is reference data, not
    # library data: the app reads it and never writes any of it onto a book. If
    # the file is absent the app simply hides the Oracle button.
    oracle = None
    oracle_script = ""
    if ORACLE.exists():
        oracle = json.loads(ORACLE.read_text(encoding="utf-8"))
        oracle_script = (
            "<script>window.__GILDED_ORACLE__ = "
            + json.dumps(oracle, ensure_ascii=False, separators=(",", ":"))
            + ";</script>\n"
        )

    # The source starts with <title> and <link>/<style>; those belong in <head>.
    # Everything from the first <svg ...> onward is body content.
    split_at = source.index("<svg style=\"display:none\"")
    head_part = source[:split_at]
    body_part = source[split_at:]

    OUT.write_text(
        HEAD + head_part + "</head>\n<body>\n" + seed_script + oracle_script + SHIM + body_part + "\n</body>\n</html>\n",
        encoding="utf-8",
    )
    note = ""
    if oracle:
        note = f", oracle {len(oracle.get('catalog', []))} candidates"
    else:
        note = ", no oracle catalogue"
    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} bytes, {len(seed)} books seeded{note})")


if __name__ == "__main__":
    main()
