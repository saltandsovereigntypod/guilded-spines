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

Output: index.html, plus manifest.webmanifest and sw.js, which make the page an
installable app that opens offline (icons live in icons/).
"""

import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).parent
SOURCE = ROOT / "artifact" / "gilded-spines.html"
SEED = ROOT / "src" / "library.seed.json"
ORACLE = ROOT / "src" / "oracle-catalog.json"
OUT = ROOT / "index.html"
MANIFEST = ROOT / "manifest.webmanifest"
WORKER = ROOT / "sw.js"

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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="A candlelit book tracker — spines on a shelf, half-step ratings, and books that open to a two-page spread.">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#100C17">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Gilded Spines">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<style>
  html,body{margin:0}
  img{max-width:100%}
  [hidden]{display:none!important}
</style>
"""


# The installed app. Paths are relative so the build works at a domain root
# (books.saltandsovereignty.com) or under a sub-path.
MANIFEST_DATA = {
    "name": "Gilded Spines",
    "short_name": "Gilded Spines",
    "description": "A shelf by candlelight: your books, your ratings, and the Oracle.",
    "id": "./",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#07060B",
    "theme_color": "#100C17",
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}

# Offline support. The page is fetched network-first so a new build shows up on
# the next open with signal; everything else (icons, fonts) is cache-first. The
# cache name carries a hash of the page, so each build retires the last one.
WORKER_JS = """/* Generated by build.py. */
var CACHE = "gilded-spines-%(version)s";
var SHELL = ["./", "index.html", "manifest.webmanifest",
             "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); })
    .then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf("gilded-spines-") === 0 && k !== CACHE; })
      .map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  if(req.mode === "navigate"){
    e.respondWith(fetch(req).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put("index.html", copy); });
      return res;
    }).catch(function(){
      return caches.match("index.html").then(function(r){ return r || caches.match("./"); });
    }));
    return;
  }
  var url = new URL(req.url);
  var fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if(url.origin !== self.location.origin && !fonts) return;
  e.respondWith(caches.match(req).then(function(hit){
    if(hit) return hit;
    return fetch(req).then(function(res){
      if(res && (res.ok || res.type === "opaque")){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); });
      }
      return res;
    });
  }));
});
"""

REGISTER = """<script>
if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  });
}
</script>
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

    page = (HEAD + head_part + "</head>\n<body>\n" + seed_script + oracle_script + SHIM + body_part +
            REGISTER + "</body>\n</html>\n")
    OUT.write_text(page, encoding="utf-8")
    MANIFEST.write_text(json.dumps(MANIFEST_DATA, indent=2) + "\n", encoding="utf-8")
    version = hashlib.sha256(page.encode("utf-8")).hexdigest()[:12]
    WORKER.write_text(WORKER_JS % {"version": version}, encoding="utf-8")
    note = ""
    if oracle:
        note = f", oracle {len(oracle.get('catalog', []))} candidates"
    else:
        note = ", no oracle catalogue"
    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} bytes, {len(seed)} books seeded{note})")


if __name__ == "__main__":
    main()
