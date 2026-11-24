/* Whisparr Upgrade - scene page + player buttons (also on every DirtyMultiscreen screen).
   ⬆  adds the Upgrade tag (the plugin then asks Whisparr for a better version).
   🗑  adds the Delete tag (only shown when "Enable delete" is on in the plugin settings).
   A dot on ⬆ means the file is below your Whisparr quality target; right-click, long-press or Shift+click
   ⬆ to search the indexers now - a badge then shows the best quality found (e.g. "4K"). */
(function () {
  "use strict";
  const PLUGIN_ID = "whisparr-upgrade";
  let cfgCache = null, cfgAt = 0;

  async function gql(query, variables) {
    const r = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }

  async function cfg() {
    if (cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
    const d = await gql("{configuration{plugins}}");
    const raw = (d.configuration.plugins || {})[PLUGIN_ID] || {};
    cfgCache = {
      upgrade: raw.UPGRADE_TAG || "Upgrade",
      pending: raw.PENDING_TAG || "Upgrade Requested",
      del: raw.DELETE_TAG || "Delete",
      later: raw.DELETE_LATER_TAG || "Delete Later",
      enableDelete: !!raw.ENABLE_DELETE,
      hide: !!raw.HIDE_BUTTONS,
    };
    cfgAt = Date.now();
    return cfgCache;
  }

  const pageSceneId = () => (location.pathname.match(/^\/scenes\/(\d+)/) || [])[1];

  /* ---------- which player / scene a button belongs to ---------- */
  function cellScene(cell) {
    const a = cell.querySelector("a.ms-scene-link");
    return a ? ((a.getAttribute("href") || "").match(/\/scenes\/(\d+)/) || [])[1] : undefined;
  }
  // { id, cell, host } for the scene a button controls, read when it is clicked.
  function where(el) {
    const cell = el && el.closest && el.closest("[data-ms-screen]");
    if (cell) return { id: cellScene(cell), cell, host: cell.querySelector(".video-js") || cell };
    return { id: pageSceneId(), cell: null, host: document.querySelector(".scene-player-container .video-js") || document.body };
  }

  function toast(host, txt) {
    host = host || document.body;
    let t = host.querySelector(".wu-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "wu-toast";
      t.style.cssText =
        "position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);" +
        "color:#fff;padding:5px 14px;border-radius:4px;font-size:15px;z-index:9999;pointer-events:none;transition:opacity .3s;" +
        "max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      host.appendChild(t);
    }
    t.textContent = txt;
    t.style.opacity = 1;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = 0), 2500);
  }

  async function getScene(id) {
    return (await gql("query($id:ID!){findScene(id:$id){title tags{id name}}}", { id })).findScene;
  }

  async function tagId(name) {
    const d = await gql(
      "query($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}}){tags{id}}}",
      { n: name }
    );
    if (d.findTags.tags.length) return d.findTags.tags[0].id;
    return (await gql("mutation($n:String!){tagCreate(input:{name:$n}){id}}", { n: name })).tagCreate.id;
  }

  async function addTag(id, scene, name) {
    const tid = await tagId(name);
    const ids = scene.tags.map((t) => t.id).filter((t) => t !== tid).concat(tid);
    await gql("mutation($id:ID!,$t:[ID!]){sceneUpdate(input:{id:$id,tag_ids:$t}){id}}", { id, t: ids });
  }

  function isRequested(scene, c) {
    const n = scene.tags.map((t) => t.name.toLowerCase());
    return n.includes(c.upgrade.toLowerCase()) || n.includes(c.pending.toLowerCase());
  }

  /* ---------- upgrade availability ---------- */
  async function runOp(args) {
    const d = await gql("mutation($p:ID!,$a:Map!){runPluginOperation(plugin_id:$p,args:$a)}", { p: PLUGIN_ID, a: args });
    return d.runPluginOperation;
  }
  // File quality vs target, asked in batches (every screen of a multiscreen at once). Cached 10 min.
  const statusCache = new Map(), waiting = new Map();
  let batchTimer = null;
  function status(sid) {
    const c = statusCache.get(sid);
    if (c && Date.now() - c.at < 600000) return Promise.resolve(c.data);
    if (!waiting.has(sid)) {
      let res;
      const pr = new Promise((r) => (res = r));
      waiting.set(sid, { pr, res });
      clearTimeout(batchTimer);
      batchTimer = setTimeout(async () => {
        const batch = new Map(waiting);
        waiting.clear();
        let out = {};
        try { out = (await runOp({ mode: "status", ids: [...batch.keys()] })) || {}; } catch (e) {}
        for (const [id, w] of batch) {
          const data = out[id] || null;
          if (data && !data.error) statusCache.set(id, { at: Date.now(), data });
          w.res(data);
        }
      }, 300);
    }
    return waiting.get(sid).pr;
  }
  // Last indexer search per scene, kept 24 h in this browser.
  const CK = "wu-check:";
  function savedCheck(sid, st) {
    try {
      const c = JSON.parse(localStorage.getItem(CK + sid) || "null");
      if (!c || Date.now() - c.at > 86400000) return null;
      if (st && st.currentRes && c.data.currentRes !== st.currentRes) return null; // the file changed since
      return c;
    } catch (e) { return null; }
  }
  const gb = (x) => (x == null ? "?" : x >= 10 ? Math.round(x) + " GB" : x >= 1 ? x.toFixed(1) + " GB" : Math.round(x * 1000) + " MB");
  // "720p, 1.2 GB → 4K, 7.5 GB (+6.3 GB)"
  function sizeLine(cur, c) {
    if (!c || !c.better) return "";
    let t = (cur.current || "?") + ", " + gb(cur.sizeGB) + "  →  " + c.best + ", " + gb(c.bestSizeGB) + (c.bestLow ? " ⚠" : "");
    if (cur.sizeGB != null && c.bestSizeGB != null) {
      const d = c.bestSizeGB - cur.sizeGB;
      t += " (" + (d >= 0 ? "+" : "−") + gb(Math.abs(d)) + ")";
    }
    return t;
  }

  // One release as two lines for the picker / tooltip.
  function relLines(r) {
    const a = [r.label || "?", r.quality, gb(r.sizeGB), r.mbps != null ? "~" + r.mbps + " Mbps" : null].filter(Boolean).join(" · ");
    const b = [r.indexer, r.seeders != null ? r.seeders + " seeder" + (r.seeders === 1 ? "" : "s") : (r.protocol === "usenet" ? "usenet" : null),
      r.low ? "⚠ low bitrate" : null, r.approved ? "✓ Whisparr's own pick" : null].filter(Boolean).join(" · ");
    return [a, b];
  }
  // How the release list is ordered. Remembered in this browser and shared with StashPicker.
  const ORDERS = [["res", "Quality"], ["indexer", "Indexer"], ["small", "Smallest"], ["large", "Largest"], ["seeders", "Seeders"]];
  const OK_KEY = "mothlight:releaseOrder";
  function getOrder() { try { const v = localStorage.getItem(OK_KEY); return ORDERS.some((o) => o[0] === v) ? v : "res"; } catch (e) { return "res"; } }
  function setOrder(v) { try { localStorage.setItem(OK_KEY, v); } catch (e) {} }
  function sortRel(list, order) {
    const p = (r) => (r.priority == null ? 25 : r.priority), sz = (r) => r.sizeGB || 0, lo = (r) => (r.low ? 1 : 0);
    const seed = (r) => (r.protocol === "usenet" ? 1e9 : r.seeders || 0); // usenet is always fully available
    const key = {
      res: (r) => [-r.res, lo(r), p(r), -sz(r), -seed(r)],
      indexer: (r) => [p(r), -r.res, lo(r), -sz(r), -seed(r)],
      small: (r) => [sz(r), -r.res, p(r)],
      large: (r) => [-sz(r), -r.res, p(r)],
      seeders: (r) => [-seed(r), -r.res, lo(r), p(r)],
    }[order] || ((r) => [-r.res, lo(r), p(r), -sz(r), -seed(r)]);
    return [...list].sort((a, b) => {
      const x = key(a), y = key(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
  }
  function paint(b) {
    const st = b._st, chk = savedCheck(b.dataset.sid, st);
    let badge = b.querySelector(".wu-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "wu-badge";
      badge.style.cssText = "position:absolute;top:2px;right:0;font:700 9px/1 system-ui,sans-serif;padding:1px 3px;" +
        "border-radius:6px;pointer-events:none;display:none";
      b.appendChild(badge);
    }
    badge.style.display = "none";
    const lines = [];
    b.style.color = b._req ? "#4caf50" : "";
    if (b._req) lines.push("Upgrade already requested");
    else lines.push("Ask Whisparr for a better-quality version");
    if (st && st.currentRes) {
      const f = st.current + (st.sizeGB != null ? ", " + gb(st.sizeGB) : "") + (st.mbps ? ", ~" + st.mbps + " Mbps" : "");
      if (st.targetRes) lines.push("File: " + f + "  ·  your target: " + st.target);
      else if (st.linked === false) lines.push("File: " + f + "  ·  not linked to StashDB, so Whisparr can't look it up");
      else if (st.inWhisparr === false) lines.push("File: " + f + "  ·  not in Whisparr");
    }
    if (chk) {
      const c = chk.data;
      if (c.error) lines.push("Last check failed: " + c.error);
      else if (c.better) {
        lines.push("Found " + c.better + " better release" + (c.better > 1 ? "s" : "") + " (" + ago(chk.at) + "):");
        lines.push("  " + sizeLine(st && st.sizeGB != null ? st : c, c));
        sortRel(c.top || [], getOrder()).slice(0, 12).forEach((r) => lines.push("  • " + relLines(r).join(" · ")));
      } else lines.push("No better version found (" + ago(chk.at) + ")");
    }
    if (!b._req) {
      if (chk && !chk.data.error && chk.data.better) {
        badge.textContent = chk.data.best;
        badge.style.cssText += ";display:block;background:#00bcd4;color:#000";
      } else if (st && st.below && !(chk && !chk.data.error && !chk.data.better)) {
        badge.textContent = "";
        badge.style.cssText += ";display:block;width:7px;height:7px;padding:0;border-radius:50%;background:#f5a623";
      }
    }
    if (st && st.movieId) lines.push("Right-click or Shift+click to search the indexers for a better version now");
    b.title = lines.join("\n");
  }
  function repaint(sid) {
    document.querySelectorAll('.wu-up[data-sid="' + sid + '"]').forEach(paint);
  }
  const checking = new Set();
  async function checkNow(btn) {
    const w = where(btn);
    if (!w.id || checking.has(w.id)) return;
    checking.add(w.id);
    toast(w.host, "Searching your indexers for a better version…");
    try {
      const data = await runOp({ mode: "check", id: w.id });
      if (!data) throw new Error("no answer from the plugin");
      try { localStorage.setItem(CK + w.id, JSON.stringify({ at: Date.now(), data })); } catch (e) {}
      repaint(w.id);
      toast(document.contains(w.host) ? w.host : document.body,
        data.error ? "Check failed: " + data.error :
        data.better ? "Better version available: " + sizeLine(data, data) :
        "No better version found right now");
      if (!data.error && data.better) pick(btn, w, data, Date.now());
    } catch (e) {
      toast(document.contains(w.host) ? w.host : document.body, "Check failed: " + e.message);
    } finally {
      checking.delete(w.id);
    }
  }

  async function upgrade(btn) {
    const w = where(btn);
    if (!w.id) return;
    try {
      const c = await cfg();
      const s = await getScene(w.id);
      if (isRequested(s, c)) {
        toast(w.host, "Upgrade already requested for this scene");
        return;
      }
      const chk = savedCheck(w.id, btn._st);
      if (chk && !chk.data.error && chk.data.better) return pick(btn, w, chk.data, chk.at, s);
      const found = chk && !chk.data.error ? `\n\nLast check (${ago(chk.at)}) found nothing better - Whisparr will keep looking.` : "";
      const v = await choose(`Upgrade "${s.title || "this scene"}"?`,
        "Whisparr will look for a better-quality version. When it downloads, it is merged into this scene, keeping markers, rating and history." + found,
        [{ label: "⬆  Let Whisparr choose (uses your quality profile)", value: "auto", main: true },
         { label: "🔍  Search now and pick a release myself", value: "search" },
         { label: "Cancel", value: null }]);
      if (v === "search") return checkNow(btn);
      if (v === "auto") await requestAuto(w, s, c);
    } catch (e) {
      alert("Upgrade request failed: " + e.message);
    }
  }

  async function requestAuto(w, s, c) {
    await addTag(w.id, s, c.upgrade);
    // every ⬆ for this scene (scene page and any screens showing it) turns green
    document.querySelectorAll('.wu-up[data-sid="' + w.id + '"]').forEach((b) => { b._req = true; paint(b); });
    toast(w.host, "Upgrade requested - Whisparr will search for a better version");
  }

  // Pick one release to download (like Whisparr's Interactive Search), or let Whisparr choose.
  async function pick(btn, w, data, at, scene) {
    try {
      const c = await cfg();
      const s = scene || await getScene(w.id);
      if (isRequested(s, c)) return toast(w.host, "Upgrade already requested for this scene");
      const cur = (btn._st && btn._st.sizeGB != null) ? btn._st : data;
      let v;
      for (;;) {
        const order = getOrder();
        const opts = ORDERS.map(([k, name]) => ({ label: name, value: { sort: k }, chip: true, on: k === order }));
        sortRel((data.top || []).filter((r) => r.guid), order).slice(0, 15)
          .forEach((r) => opts.push({ label: relLines(r).join("\n"), value: r }));
        opts.push({ label: "⬆  Let Whisparr choose (uses your quality profile)", value: "auto", main: true });
        opts.push({ label: "Cancel", value: null });
        v = await choose(`Pick a version of "${s.title || "this scene"}"`,
          "Your file: " + cur.current + ", " + gb(cur.sizeGB) + (cur.mbps ? ", ~" + cur.mbps + " Mbps" : "") +
          "   (checked " + ago(at) + ")\n⚠ = low bitrate for its resolution: often a heavy re-encode, an upscale or a shorter cut.\n" +
          "The one you pick downloads now and is merged into this scene when it arrives.", opts);
        if (v && v.sort) { setOrder(v.sort); continue; }
        break;
      }
      if (!v) return;
      if (v === "auto") return requestAuto(w, s, c);
      toast(w.host, "Sending " + v.label + " to the download client…");
      const out = await runOp({ mode: "grab", id: w.id, guid: v.guid, indexerId: v.indexerId });
      if (!out || out.error) return toast(document.contains(w.host) ? w.host : document.body, "Couldn't grab it: " + ((out && out.error) || "no answer"));
      document.querySelectorAll('.wu-up[data-sid="' + w.id + '"]').forEach((b) => { b._req = true; paint(b); });
      toast(document.contains(w.host) ? w.host : document.body, "Downloading " + v.label + ", " + gb(v.sizeGB) + " - it will be merged into this scene");
    } catch (e) {
      alert("Upgrade failed: " + e.message);
    }
  }

  // On a multiscreen screen: press that screen's own "next" button.
  function nextOnScreen(cell) {
    const bar = cell.querySelector(".vjs-control-bar");
    if (!bar) return false;
    const btn = [...bar.querySelectorAll("button")].find((b) => {
      const s = (b.className + " " + (b.title || "") + " " + (b.getAttribute("aria-label") || "") + " " +
        ((b.querySelector(".vjs-control-text") || {}).textContent || "")).toLowerCase();
      return /next|skip.?forward/.test(s) && !/marker|xp-/.test(s);
    });
    if (btn) { btn.click(); return true; }
    return false;
  }

  // A small dialog with several choices (confirm() only has OK/Cancel).
  // Shown inside the fullscreen player when there is one, so it is never hidden behind it.
  function choose(title, text, options) {
    return new Promise((resolve) => {
      const host = document.fullscreenElement || document.body;
      const back = document.createElement("div");
      back.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;";
      const box = document.createElement("div");
      box.style.cssText = "background:#202b33;color:#eee;border:1px solid #394b59;border-radius:10px;padding:18px;width:min(420px,92vw);max-height:88vh;overflow:auto;font:14px system-ui,sans-serif;box-shadow:0 6px 24px #000a;";
      const h = document.createElement("div");
      h.textContent = title;
      h.style.cssText = "font-weight:700;font-size:15px;margin-bottom:6px;overflow-wrap:anywhere";
      const p = document.createElement("div");
      p.textContent = text;
      p.style.cssText = "opacity:.8;margin-bottom:12px;white-space:pre-line";
      box.append(h, p);
      const finish = (v) => { back.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } };
      let chips = null;
      for (const o of options) {
        if (o.chip) {
          if (!chips) {
            chips = document.createElement("div");
            chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:2px 0 4px;font-size:12px";
            chips.append(Object.assign(document.createElement("span"), { textContent: "Sort by:", style: "opacity:.7;margin-right:2px" }));
            box.appendChild(chips);
          }
          const c = document.createElement("button");
          c.type = "button";
          c.textContent = o.label;
          c.style.cssText = "padding:3px 9px;border-radius:12px;cursor:pointer;font:600 12px system-ui,sans-serif;border:1px solid " +
            (o.on ? "#137cbd;background:#137cbd;color:#fff" : "#394b59;background:transparent;color:#ccc");
          c.addEventListener("click", (e) => { e.stopPropagation(); if (!o.on) finish(o.value); });
          chips.appendChild(c);
          continue;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = o.label;
        b.style.cssText = "display:block;width:100%;margin-top:8px;padding:10px 12px;white-space:pre-line;line-height:1.35;border:0;border-radius:6px;cursor:pointer;text-align:left;font:600 14px system-ui,sans-serif;color:#fff;background:" +
          (o.danger ? "#c23030" : o.main ? "#137cbd" : "#394b59");
        b.addEventListener("click", (e) => { e.stopPropagation(); finish(o.value); });
        box.appendChild(b);
      }
      back.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === back) finish(null); });
      back.addEventListener("pointerdown", (e) => e.stopPropagation());
      document.addEventListener("keydown", key, true);
      back.appendChild(box);
      host.appendChild(back);
    });
  }

  const hasTag = (scene, name) => scene.tags.some((t) => t.name.toLowerCase() === name.toLowerCase());

  async function removeTag(id, scene, name) {
    const ids = scene.tags.filter((t) => t.name.toLowerCase() !== name.toLowerCase()).map((t) => t.id);
    await gql("mutation($id:ID!,$t:[ID!]){sceneUpdate(input:{id:$id,tag_ids:$t}){id}}", { id, t: ids });
  }

  function paintDel(b, later) {
    b._later = later;
    b.style.color = later ? "#f5a623" : "";
    b.title = later ? "Tagged to delete later - click to delete now or remove the tag"
                    : "Delete scene + file (and exclude in Whisparr), or tag it to delete later";
  }

  async function del(btn) {
    const w = where(btn);
    if (!w.id) return;
    try {
      const c = await cfg();
      if (!c.enableDelete) return;
      const s = await getScene(w.id);
      const later = hasTag(s, c.later);
      const name = s.title || "this scene";
      const opts = [
        { label: "🗑  Delete now - scene, file and Whisparr exclusion", value: "now", danger: true },
        later ? { label: "↩  Keep it - remove the \"" + c.later + "\" tag", value: "untag" }
              : { label: "🏷  Tag it to delete later (\"" + c.later + "\")", value: "later", main: true },
        { label: "Cancel", value: null },
      ];
      const pick = await choose(
        "Delete \"" + name + "\"?",
        (later ? "This scene is already tagged to delete later.\n\n" : "") +
        "Deleting now removes the scene and its file, and excludes it in Whisparr so it is never downloaded again." +
        (later ? "" : "\nTagging only marks it - nothing is deleted, and you can find it later by filtering on the tag."),
        opts);
      if (!pick) return;
      if (pick === "later" || pick === "untag") {
        if (pick === "later") await addTag(w.id, s, c.later);
        else await removeTag(w.id, s, c.later);
        document.querySelectorAll('.wu-del[data-sid="' + w.id + '"]').forEach((b) => paintDel(b, pick === "later"));
        toast(w.host, pick === "later" ? "Tagged \"" + c.later + "\" - nothing deleted" : "Removed the \"" + c.later + "\" tag");
        return;
      }
      if (w.cell) {
        // Multiscreen: keep the grid open, move this screen on, then delete.
        const host = w.host;
        if (!nextOnScreen(w.cell)) {
          const v = w.cell.querySelector("video");
          if (v) v.pause();
        }
        await addTag(w.id, s, c.del);
        toast(document.contains(host) ? host : w.cell, "Deleted \"" + (s.title || "scene") + "\"");
        return;
      }
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      await addTag(w.id, s, c.del);
      if (history.length > 1) history.back();
      else location.assign("/scenes");
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  function mk(cls, txt, onClick, player, sid) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = (player ? "vjs-control vjs-button " : "minimal btn btn-secondary ") + cls;
    b.dataset.sid = sid;
    if (player) {
      // size the symbol, not the button, so it keeps the player's row height
      b.style.cssText = "cursor:pointer;width:2.4em;display:flex;align-items:center;justify-content:center;position:relative;";
      const g = document.createElement("span");
      g.textContent = txt;
      g.style.cssText = "font-size:1.6em;line-height:1;font-weight:bold;";
      b.appendChild(g);
    } else {
      b.textContent = txt;
      b.style.cssText = "font-size:1em;padding:0 .45em;line-height:1.6;position:relative;";
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  // Every place buttons should be: [host element, is it a player bar, scene id]
  function targets() {
    const out = [];
    const id = pageSceneId();
    if (id) {
      const bar = document.querySelector(".scene-player-container .vjs-control-bar");
      // Scene-page buttons go in the line under the title, between the date and
      // the quality (e.g. "29.97 fps | 1080p"); fall back to the toolbar.
      const tb = document.querySelector(".scene-subheader") || document.querySelector(".scene-toolbar");
      if (bar) out.push([bar, true, id]);
      if (tb) out.push([tb, false, id]);
    }
    for (const cell of document.querySelectorAll(".ms-route [data-ms-screen]")) {
      const sid = cellScene(cell);
      const bar = cell.querySelector(".ms-native-tile .vjs-control-bar");
      if (sid && bar) out.push([bar, true, sid]);
    }
    return out;
  }

  let busy = false;
  async function inject() {
    if (busy) return;
    const todo = targets().filter(([host, , sid]) => !host.querySelector(".wu-up") || host.dataset.wuSid !== sid);
    if (!todo.length) return;
    busy = true;
    try {
      const c = await cfg();
      if (c.hide) return;
      const states = {};
      for (const [host, player, sid] of todo) {
        if (!(sid in states)) {
          const sc = await getScene(sid);
          states[sid] = { req: isRequested(sc, c), later: hasTag(sc, c.later) };
        }
        if (!document.contains(host)) continue;
        host.querySelectorAll(".wu-btn").forEach((x) => x.remove());
        host.dataset.wuSid = sid;
        const wrap = player ? host : document.createElement("span");
        if (!player) {
          wrap.className = "wu-btn";
          wrap.style.cssText = "display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;";
          if (host.classList.contains("scene-subheader")) {
            host.style.alignItems = "center";
            const date = host.querySelector(":scope > .date");
            host.insertBefore(wrap, date ? date.nextSibling : host.firstChild);
          } else {
            host.style.flexWrap = "wrap";
            wrap.classList.add("scene-toolbar-group");
            wrap.style.marginLeft = "auto";
            host.appendChild(wrap);
          }
        }
        const ref = player ? host.querySelector(".vjs-fullscreen-control") : null;
        const up = mk("wu-btn wu-up", "⬆", upgrade, player, sid);
        up._req = states[sid].req;
        paint(up);
        status(sid).then((st) => { if (st && !st.error) { up._st = st; paint(up); } });
        wrap.insertBefore(up, ref);
        if (c.enableDelete) {
          const d = mk("wu-btn wu-del", "🗑", del, player, sid);
          paintDel(d, states[sid].later);
          wrap.insertBefore(d, ref);
        }
      }
    } catch (e) {
      /* ignore - try again on next change */
    } finally {
      busy = false;
    }
  }

  // Right-click (or long-press) or Shift+click on ⬆: search the indexers now.
  // Listened for on the whole page, so it still works if a theme rebuilds the player's buttons,
  // and before anything else so neither Chrome's nor DirtyMultiscreen's menu opens.
  function upFrom(e) { return e.target && e.target.closest ? e.target.closest(".wu-up") : null; }
  document.addEventListener("contextmenu", (e) => {
    const b = upFrom(e);
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    checkNow(b);
  }, true);
  document.addEventListener("click", (e) => {
    if (!e.shiftKey) return;
    const b = upFrom(e);
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    checkNow(b);
  }, true);

  let t = null;
  new MutationObserver(() => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      inject();
    }, 400);
  }).observe(document.body, { childList: true, subtree: true });
  inject();
})();
