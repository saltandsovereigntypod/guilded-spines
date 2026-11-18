/* ------------------------------------------------------------------
   Standalone persistence, with sync across devices.

   Inside a Claude Artifact, window.claude.use("db") hands the app a
   shared, account-backed document store. Outside one, that doesn't
   exist, so this stands up the same surface the app uses
   (doc(path).set/.delete/.onSnapshot, collection("books").onSnapshot)
   over localStorage.

   The local copy is always what the app reads and writes, so the shelf
   works offline and opens instantly. Once you sign in with an emailed
   code, every change is also traded with the Gilded Spines Supabase
   project in the background:

     - each document (a book, the settings, an image) carries a revision,
       the writing device's clock; the newest revision of a document wins,
       and the server refuses a write older than what it holds;
     - deletions are kept as tombstones so every device learns of them;
     - the first time a device signs in, its shelf is merged into the
       account's rather than laid over it: books with the same id are
       combined field by field, and a book added separately on two devices
       (same title and author, different ids) becomes one book;
     - after every pull that same title-and-author check runs again, and it
       always keeps the same one of a pair, so two devices converge on one
       copy instead of trading duplicates.

   Row level security on the server lets an account read and write only
   its own rows; the key below is the project's publishable key, which is
   safe to ship in a page.
   ------------------------------------------------------------------ */
(function(){
  if(window.claude && window.claude.use) return;   // real runtime wins

  var SB_URL = "__SB_URL__", SB_KEY = "__SB_KEY__";
  var KEY = "gilded-spines.library.v1", META = "gilded-spines.sync.v1";
  var SEED = window.__GILDED_SEED__ || {};

  function readJSON(k){ try { return JSON.parse(localStorage.getItem(k)) || null; } catch(e){ return null; } }
  function writeJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }

  var store = readJSON(KEY), freshSeed = false;
  if(!store){ store = { books: SEED, settings: {} }; freshSeed = true; writeJSON(KEY, store); }
  if(!store.books) store.books = {};
  if(!store.settings) store.settings = {};
  function write(){ writeJSON(KEY, store); }

  /* Revisions. A freshly seeded shelf is revision 0, so any account's copy of
     the same book wins over it; a shelf that existed before sync is
     revision 1, real data that the first sync merges rather than drops. */
  var meta = readJSON(META);
  if(!meta){
    meta = { revs:{}, dirty:{}, cursor:null, session:null, done:{}, last:null };
    var base = freshSeed ? 0 : 1;
    Object.keys(store.books).forEach(function(id){ meta.revs["book/" + id] = base; });
    /* The starter shelf a brand-new device begins with. The app itself writes
       to some of these on its first run (filling in years, say), so an edit is
       no sign they are the reader's: they are never sent to an account. */
    meta.starter = {};
    if(freshSeed) Object.keys(store.books).forEach(function(id){ meta.starter[id] = true; });
    if(store.settings.prefs) meta.revs["prefs/prefs"] = base;
    writeJSON(META, meta);
  }
  ["revs","dirty","done","starter"].forEach(function(k){ if(!meta[k]) meta[k] = {}; });
  function saveMeta(){ writeJSON(META, meta); }
  function nextRev(key){ var r = Math.max(Date.now(), (meta.revs[key] || 0) + 1); meta.revs[key] = r; return r; }

  /* ---------------- the document surface the app uses ---------------- */
  var bookListeners = [], docListeners = {};
  function snapOf(id, body){
    return { id:id, exists:!!body, data:function(){ return body; }, metadata:{ fromCache:true, hasPendingWrites:false } };
  }
  function pushBooks(){
    var docs = Object.keys(store.books).sort().map(function(id){ return snapOf(id, store.books[id]); });
    var snap = { docs:docs, size:docs.length, empty:!docs.length, docChanges:function(){ return []; }, metadata:{ fromCache:true, hasPendingWrites:false } };
    bookListeners.forEach(function(fn){ try { fn(snap); } catch(e){} });
  }
  function pushDoc(path){
    (docListeners[path] || []).forEach(function(fn){ try { fn(snapOf(path.split("/").pop(), bodyAt(path))); } catch(e){} });
  }
  function bodyAt(path){
    var p = path.split("/");
    if(p[0] === "books") return store.books[p[1]];
    if(p[0] === "settings") return store.settings[p[1]];
    return undefined;
  }
  function syncKey(path){
    var p = path.split("/");
    if(p[0] === "books") return "book/" + p[1];
    if(p[0] === "settings" && p[1] === "prefs") return "prefs/prefs";
    return null;
  }
  function setAt(path, data){
    var p = path.split("/");
    if(p[0] === "books") store.books[p[1]] = data;
    else if(p[0] === "settings") store.settings[p[1]] = data;
    write();
    var k = syncKey(path);
    if(k){ nextRev(k); meta.dirty[k] = true; saveMeta(); soon(); }
  }
  function delAt(path){
    var p = path.split("/");
    if(p[0] === "books") delete store.books[p[1]];
    else if(p[0] === "settings") delete store.settings[p[1]];
    write();
    var k = syncKey(path);
    if(k){ nextRev(k); meta.dirty[k] = true; saveMeta(); soon(); }
  }
  function docRef(path){
    return {
      id: path.split("/").pop(), path: path,
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
      acquire: function(){ return Promise.resolve({ acquired:true }); },
      onSnapshot: function(next){
        (docListeners[path] = docListeners[path] || []).push(next);
        setTimeout(function(){ next(snapOf(path.split("/").pop(), bodyAt(path))); }, 0);
        return function(){ docListeners[path] = (docListeners[path] || []).filter(function(f){ return f !== next; }); };
      },
      collection: function(sub){ return collectionRef(path + "/" + sub); }
    };
  }
  function collectionRef(path){
    return {
      path: path,
      doc: function(id){ return docRef(path + "/" + (id || ("id-" + Date.now().toString(36)))); },
      add: function(data){ var r = this.doc(); return r.set(data).then(function(){ return r; }); },
      where: function(){ return this; }, orderBy: function(){ return this; }, limit: function(){ return this; },
      get: function(){
        var docs = Object.keys(store.books).sort().map(function(id){ return snapOf(id, store.books[id]); });
        return Promise.resolve({ docs:docs, size:docs.length, empty:!docs.length, docChanges:function(){ return []; } });
      },
      onSnapshot: function(next){
        if(path !== "books"){ setTimeout(function(){ next({ docs:[], size:0, empty:true, docChanges:function(){ return []; } }); }, 0); return function(){}; }
        bookListeners.push(next);
        setTimeout(pushBooks, 0);
        return function(){ bookListeners = bookListeners.filter(function(f){ return f !== next; }); };
      }
    };
  }
  var localDb = { doc:docRef, collection:collectionRef };
  window.claude = { use: function(name){ return Promise.resolve(name === "db" ? localDb : null); } };

  /* ---------------- images, kept by the app in IndexedDB ---------------- */
  var images = null;            // the app registers {get, put, del, keys}
  var pendingImages = [];       // remote images that arrived before it did
  function imageChanged(key){
    var k = "image/" + key;
    nextRev(k); meta.dirty[k] = true; saveMeta(); soon();
  }

  /* ---------------- merging two copies of a book ----------------
     The base copy keeps its fields; the other fills whatever the base lacks.
     Reads and genres are unioned, ratings filled per category, note sections
     joined by name, so nothing written on either device is lost. */
  function empty(v){
    return v == null || v === "" || (Array.isArray(v) && !v.length) ||
      (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  }
  var STATUS_RANK = { want:0, paused:1, dnf:2, reading:3, read:4 };
  function mergeBooks(base, other){
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(other).forEach(function(k){ if(empty(out[k]) && !empty(other[k])) out[k] = JSON.parse(JSON.stringify(other[k])); });
    var reads = (base.reads || []).concat(other.reads || []), seen = {};
    out.reads = reads.filter(function(r){
      var id = (r && (r.end || "")) + "|" + (r && (r.start || "")) + "|" + (r && r.dnf ? 1 : 0);
      if(!r || seen[id]) return false;
      seen[id] = true; return true;
    }).sort(function(a, b){ return String(a.end || a.start || "").localeCompare(String(b.end || b.start || "")); });
    /* A read with an exact date replaces an approximate one for the same month or year. */
    out.reads = out.reads.filter(function(r){
      if(!r.approx || !r.end) return true;
      var span = r.approx === "year" ? 4 : 7;
      return !out.reads.some(function(o){ return o !== r && !o.approx && o.end && o.end.slice(0, span) === r.end.slice(0, span); });
    });
    if(!out.reads.length) delete out.reads;
    if(base.genres || other.genres){
      out.genres = (base.genres || []).concat(other.genres || []).filter(function(g, i, a){ return a.indexOf(g) === i; });
    }
    if(base.ratings || other.ratings) out.ratings = Object.assign({}, other.ratings || {}, base.ratings || {});
    out.favorite = !!(base.favorite || other.favorite);
    if((STATUS_RANK[other.status] || 0) > (STATUS_RANK[base.status] || 0)) out.status = other.status;
    if(typeof other.progress === "number") out.progress = Math.max(out.progress || 0, other.progress);
    if(typeof base.addedAt === "number" && typeof other.addedAt === "number") out.addedAt = Math.min(base.addedAt, other.addedAt);
    var secs = (out.sections || []).map(function(s){ return { id:s.id, label:s.label, text:s.text || "" }; });
    (other.sections || []).forEach(function(s){
      if(!s || !s.text) return;
      var same = secs.filter(function(x){ return x.label === s.label; })[0];
      if(!same) secs.push({ id:s.id, label:s.label, text:s.text });
      else if(!same.text) same.text = s.text;
      else if(same.text.indexOf(s.text) === -1 && s.text.indexOf(same.text) === -1) same.text += "\n\n" + s.text;
      else if(s.text.length > same.text.length) same.text = s.text;
    });
    if(secs.length) out.sections = secs;
    out.id = base.id;
    return out;
  }
  function norm(t){
    return String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim().replace(/^(the|a|an) /, "");
  }
  function sameKey(b){
    var t = norm(b.title);
    if(!t || t === "untitled") return null;
    return t + "|" + norm(b.author);
  }
  function moveImages(fromId, toId){
    if(!images) return Promise.resolve();
    return Promise.all(["cover","spine"].map(function(kind){
      var from = fromId + ":" + kind, to = toId + ":" + kind;
      return images.get(from).then(function(v){
        if(!v) return;
        return images.get(to).then(function(have){
          var step = have ? Promise.resolve() : images.put(to, v).then(function(){ imageChanged(to); });
          return step.then(function(){ return images.del(from); }).then(function(){ imageChanged(from); });
        });
      });
    })).catch(function(){});
  }
  /* Same title and author, different ids: keep the one added first (the
     smaller id on a tie), fold the other into it, and delete the other. Every
     device makes the same choice, so they converge. */
  function dedupe(){
    var groups = {}, changed = false;
    Object.keys(store.books).forEach(function(id){
      var b = store.books[id], k = b && sameKey(b);
      if(k) (groups[k] = groups[k] || []).push(b);
    });
    Object.keys(groups).forEach(function(k){
      var g = groups[k];
      if(g.length < 2) return;
      g.sort(function(a, b){ return ((a.addedAt || 0) - (b.addedAt || 0)) || (a.id < b.id ? -1 : 1); });
      var keep = g[0];
      g.slice(1).forEach(function(dup){
        keep = mergeBooks(keep, dup);
        delete store.books[dup.id];
        var dk = "book/" + dup.id;
        nextRev(dk); meta.dirty[dk] = true;
        moveImages(dup.id, keep.id);
      });
      if(keep.coverImage === false && g.some(function(b){ return b.coverImage; })) keep.coverImage = true;
      store.books[keep.id] = keep;
      var kk = "book/" + keep.id;
      nextRev(kk); meta.dirty[kk] = true;
      changed = true;
    });
    if(changed){ write(); saveMeta(); }
    return changed;
  }

  /* ---------------- the server ---------------- */
  var state = { status:"signed-out", message:"", busy:false, email:(meta.session && meta.session.email) || "", pendingEmail:"" };
  var statusFns = [];
  function emit(){ statusFns.forEach(function(fn){ try { fn(api.status()); } catch(e){} }); }
  function setStatus(s, msg){ state.status = s; state.message = msg || ""; emit(); }

  function req(method, path, body, extra){
    var h = { apikey:SB_KEY, "Content-Type":"application/json" };
    if(meta.session && meta.session.access) h.Authorization = "Bearer " + meta.session.access;
    Object.keys(extra || {}).forEach(function(k){ h[k] = extra[k]; });
    return fetch(SB_URL + path, { method:method, headers:h, body:body == null ? undefined : JSON.stringify(body) })
      .then(function(r){
        return r.text().then(function(t){
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch(e){}
          if(!r.ok){ var err = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ("HTTP " + r.status)); err.status = r.status; err.body = j; throw err; }
          return j;
        });
      });
  }
  function takeSession(j){
    if(!j || !j.access_token) throw new Error("No session in the reply");
    meta.session = {
      access:j.access_token, refresh:j.refresh_token,
      exp:Date.now() + ((j.expires_in || 3600) - 60) * 1000,
      uid:j.user && j.user.id, email:(j.user && j.user.email) || state.pendingEmail || (meta.session && meta.session.email)
    };
    state.email = meta.session.email || "";
    saveMeta();
  }
  function fresh(){
    var s = meta.session;
    if(!s) return Promise.reject(new Error("Not signed in"));
    if(Date.now() < s.exp) return Promise.resolve();
    return req("POST", "/auth/v1/token?grant_type=refresh_token", { refresh_token:s.refresh }).then(takeSession, function(e){
      if(e.status === 400 || e.status === 401 || e.status === 403){ meta.session = null; saveMeta(); setStatus("signed-out", "Signed out: please sign in again."); }
      throw e;
    });
  }

  function rowFor(key){
    var i = key.indexOf("/"), kind = key.slice(0, i), id = key.slice(i + 1);
    var row = { user_id:meta.session.uid, kind:kind, id:id, rev:meta.revs[key] || Date.now(), deleted:false, data:null };
    if(kind === "book"){
      if(store.books[id]) row.data = store.books[id]; else row.deleted = true;
      return Promise.resolve(row);
    }
    if(kind === "prefs"){
      if(store.settings.prefs) row.data = store.settings.prefs; else row.deleted = true;
      return Promise.resolve(row);
    }
    if(!images) return Promise.resolve(null);
    return images.get(id).then(function(v){
      if(typeof v === "string") row.data = { url:v }; else row.deleted = true;
      return row;
    }, function(){ return null; });
  }
  function push(){
    var keys = Object.keys(meta.dirty);
    if(!keys.length) return Promise.resolve(0);
    return Promise.all(keys.map(rowFor)).then(function(rows){
      rows = rows.filter(Boolean);
      /* Batches of about 1 MB; an image can be a few hundred kilobytes. */
      var batches = [], cur = [], size = 0;
      rows.forEach(function(r){
        var n = JSON.stringify(r).length;
        if(cur.length && size + n > 1000000){ batches.push(cur); cur = []; size = 0; }
        cur.push(r); size += n;
      });
      if(cur.length) batches.push(cur);
      var sent = 0;
      return batches.reduce(function(p, batch){
        return p.then(function(){
          return req("POST", "/rest/v1/docs?on_conflict=user_id,kind,id", batch,
            { Prefer:"resolution=merge-duplicates,return=minimal" }).then(function(){
            batch.forEach(function(r){
              var k = r.kind + "/" + r.id;
              if((meta.revs[k] || 0) <= r.rev) delete meta.dirty[k];
            });
            sent += batch.length;
            saveMeta();
          });
        });
      }, Promise.resolve()).then(function(){ return sent; });
    });
  }
  function pullAll(since){
    var out = [];
    function page(from){
      var q = "/rest/v1/docs?select=kind,id,data,rev,deleted,synced_at&order=synced_at.asc,kind.asc,id.asc&limit=500&offset=" + from +
        (since ? "&synced_at=gt." + encodeURIComponent(since) : "");
      return req("GET", q).then(function(rows){
        out = out.concat(rows || []);
        return rows && rows.length === 500 ? page(from + 500) : out;
      });
    }
    return page(0);
  }
  /* Apply what the server holds where it is newer than ours. */
  function applyRows(rows, first){
    var books = false, prefs = false, imgs = [];
    rows.forEach(function(r){
      var key = r.kind + "/" + r.id, mine = meta.revs[key] || 0;
      if(r.kind === "book"){
        var local = store.books[r.id];
        if(first && local && !r.deleted && mine > 0){
          /* First sign-in on this device: both copies are real, so combine them. */
          var merged = mergeBooks(r.data, local);
          store.books[r.id] = merged;
          if(JSON.stringify(merged) !== JSON.stringify(r.data)){ nextRev(key); meta.dirty[key] = true; }
          else { meta.revs[key] = r.rev; delete meta.dirty[key]; }
          books = true;
          return;
        }
        if(!(first && meta.starter[r.id]) && (r.rev < mine || (r.rev === mine && meta.dirty[key]))) return;
        if(r.deleted) delete store.books[r.id]; else store.books[r.id] = r.data;
        meta.revs[key] = r.rev; delete meta.dirty[key]; books = true;
      } else if(r.kind === "prefs"){
        /* The account's settings win on a device's first sign-in. */
        if(!first && (r.rev < mine || (r.rev === mine && meta.dirty[key]))) return;
        if(r.deleted) delete store.settings.prefs; else store.settings.prefs = r.data;
        meta.revs[key] = r.rev; delete meta.dirty[key]; prefs = true;
      } else if(r.kind === "image"){
        if(!first && (r.rev < mine || (r.rev === mine && meta.dirty[key]))) return;
        if(first && mine > 1 && meta.dirty[key]) return;
        meta.revs[key] = r.rev; delete meta.dirty[key];
        imgs.push({ key:r.id, url:r.deleted || !r.data ? null : r.data.url });
      }
    });
    var cursor = rows.length ? rows[rows.length - 1].synced_at : null;
    write(); saveMeta();
    return { books:books, prefs:prefs, imgs:imgs, cursor:cursor };
  }
  function applyImages(list){
    if(!list.length) return Promise.resolve();
    if(!images){ pendingImages = pendingImages.concat(list); return Promise.resolve(); }
    return Promise.all(list.map(function(x){ return (x.url ? images.put(x.key, x.url) : images.del(x.key)).catch(function(){}); }))
      .then(function(){ if(images.refreshed) images.refreshed(list.map(function(x){ return x.key; })); });
  }
  /* A device signing in for the first time: everything it holds that the
     account does not is sent up; a book the account already has under
     another id (same title and author) is folded into the account's copy. */
  function firstMerge(rows){
    var serverBooks = {}, byTitle = {};
    rows.forEach(function(r){
      if(r.kind === "book" && !r.deleted && r.data){ serverBooks[r.id] = r.data; var k = sameKey(r.data); if(k && !byTitle[k]) byTitle[k] = r.id; }
    });
    var res = applyRows(rows, true);
    Object.keys(store.books).forEach(function(id){
      if(serverBooks[id]) return;
      var b = store.books[id], key = "book/" + id;
      if(meta.starter[id] || (meta.revs[key] || 0) === 0){
        /* An untouched copy of the starter shelf a new device begins with: it is
           never sent to an account, so a new account starts empty and an
           existing one keeps exactly its own books. */
        delete store.books[id]; delete meta.revs[key]; delete meta.dirty[key]; return;
      }
      var k = sameKey(b), match = k && byTitle[k];
      if(match && store.books[match]){
        store.books[match] = mergeBooks(store.books[match], b);
        var mk = "book/" + match; nextRev(mk); meta.dirty[mk] = true;
        delete store.books[id];
        nextRev(key); meta.dirty[key] = true;
        moveImages(id, match);
      } else {
        nextRev(key); meta.dirty[key] = true;
      }
    });
    if(!rows.some(function(r){ return r.kind === "prefs"; }) && store.settings.prefs){ nextRev("prefs/prefs"); meta.dirty["prefs/prefs"] = true; }
    write(); saveMeta();
    var up = images ? images.keys().then(function(keys){
      var have = {};
      rows.forEach(function(r){ if(r.kind === "image") have[r.id] = true; });
      (keys || []).forEach(function(k){ if(!have[k]){ nextRev("image/" + k); meta.dirty["image/" + k] = true; } });
      saveMeta();
    }, function(){}) : Promise.resolve();
    return up.then(function(){ return res; });
  }

  function clearLocal(){
    store.books = {}; store.settings = {}; write();
    meta.revs = {}; meta.dirty = {}; meta.done = {}; meta.cursor = null; meta.owner = null; saveMeta();
    pushBooks(); pushDoc("settings/prefs");
    if(!images) return Promise.resolve();
    return images.keys().then(function(keys){
      return Promise.all((keys || []).map(function(k){ return images.del(k).catch(function(){}); }));
    }, function(){}).then(function(){ if(images.refreshed) images.refreshed([]); });
  }

  var syncing = null, again = false, timer = null;
  function soon(){
    if(!meta.session) return;
    clearTimeout(timer);
    timer = setTimeout(function(){ sync(); }, 2000);
  }
  function sync(){
    if(!meta.session) return Promise.resolve();
    if(syncing){ again = true; return syncing; }
    if(navigator.onLine === false){ setStatus("offline", "Offline: changes will sync when you are back online."); return Promise.resolve(); }
    setStatus("syncing", "Syncing…");
    var uid;
    syncing = fresh().then(function(){
      uid = meta.session.uid;
      if(meta.owner && meta.owner !== uid){
        if(Object.keys(meta.dirty).length){
          var why = "This device has changes from another account that haven’t synced yet. Sign in to that account first so they’re saved.";
          meta.session = null; saveMeta(); setStatus("signed-out", why);
          throw new Error(why);
        }
        return clearLocal().then(function(){ return uid; });
      }
    }).then(function(){
      var first = !meta.done[uid];
      var since = first ? null : (meta.cursor && meta.cursor[uid]);
      /* Overlap the cursor a little, so a write committed just behind the last
         row read is not skipped; re-reading a row is harmless. */
      if(since) since = new Date(new Date(since).getTime() - 5000).toISOString();
      return pullAll(since).then(function(rows){
        var step = first ? firstMerge(rows) : Promise.resolve(applyRows(rows, false));
        return step.then(function(res){
          if(res.cursor){ meta.cursor = meta.cursor || {}; meta.cursor[uid] = res.cursor; }
          var deduped = dedupe();
          return applyImages(res.imgs).then(function(){
            if(res.books || first || deduped) pushBooks();
            if(res.prefs || first) pushDoc("settings/prefs");
            return push();
          });
        });
      }).then(function(){
        meta.done[uid] = true;
        meta.owner = uid;
        meta.starter = {};
        meta.last = Date.now();
        saveMeta();
      });
    }).then(function(){
      setStatus("synced", "");
    }, function(e){
      if(!meta.session) return;
      setStatus(navigator.onLine === false ? "offline" : "error",
        navigator.onLine === false ? "Offline: changes will sync when you are back online." : "Couldn’t sync: " + (e && e.message || "unknown error"));
    }).then(function(){
      syncing = null;
      if(again){ again = false; return sync(); }
    });
    return syncing;
  }

  var api = {
    configured: !!(SB_URL && SB_KEY && SB_URL.indexOf("__") !== 0),
    status: function(){
      return { status: meta.session ? state.status : "signed-out", message: state.message,
        email: meta.session ? (meta.session.email || state.email) : "", pendingEmail: state.pendingEmail,
        last: meta.last, pending: Object.keys(meta.dirty).length };
    },
    onChange: function(fn){ statusFns.push(fn); fn(api.status()); return function(){ statusFns = statusFns.filter(function(f){ return f !== fn; }); }; },
    sendCode: function(email){
      email = String(email || "").trim();
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Promise.reject(new Error("That doesn’t look like an email address"));
      state.pendingEmail = email;
      return req("POST", "/auth/v1/otp", { email:email, create_user:true }).then(function(){ setStatus("code-sent", ""); });
    },
    verify: function(code){
      code = String(code || "").replace(/\s+/g, "");
      return req("POST", "/auth/v1/verify", { type:"email", email:state.pendingEmail, token:code }).then(function(j){
        var uid = j && j.user && j.user.id;
        /* This device's shelf belongs to one account. Another account signing
           in gets its own shelf here, never a merge with the last one's. */
        if(meta.owner && uid && meta.owner !== uid){
          if(Object.keys(meta.dirty).length){
            throw new Error("This device has changes from another account that haven’t synced yet. Sign in to that account first so they’re saved.");
          }
          return clearLocal().then(function(){ takeSession(j); state.pendingEmail = ""; return sync(); });
        }
        takeSession(j);
        state.pendingEmail = "";
        return sync();
      });
    },
    syncNow: function(){ return sync(); },
    signOut: function(){
      var s = meta.session;
      var done = function(){ meta.session = null; saveMeta(); setStatus("signed-out", "Signed out. This device keeps its copy of your shelf."); };
      if(!s) { done(); return Promise.resolve(); }
      return req("POST", "/auth/v1/logout", {}).then(done, done);
    },
    /* The app's image store: images it saves come here, and images from
       other devices go to it. */
    setImageStore: function(s){
      images = s;
      if(pendingImages.length){ var p = pendingImages; pendingImages = []; applyImages(p); }
    },
    imageChanged: imageChanged,
    mergeBooks: mergeBooks
  };
  window.__gsSync = api.configured ? api : null;

  if(api.configured && meta.session){
    setTimeout(sync, 800);
    document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") sync(); });
    window.addEventListener("online", function(){ sync(); });
    setInterval(function(){ if(document.visibilityState === "visible") sync(); }, 60000);
  } else if(api.configured){
    /* Start listening once a session exists. */
    var on = false;
    api.onChange(function(st){
      if(on || st.status === "signed-out" || st.status === "code-sent") return;
      on = true;
      document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") sync(); });
      window.addEventListener("online", function(){ sync(); });
      setInterval(function(){ if(document.visibilityState === "visible") sync(); }, 60000);
    });
  }
})();
