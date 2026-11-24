// Whisparr Upgrade - Stash UI extension: ⬆ and 🗑 in Stash UI's player control bar.
// Loaded by Stash UI from /plugin/whisparr-upgrade/assets/stashui.js. The server side
// (Whisparr search, merge, delete + exclusion, quality status and release checks) is the same
// plugin as in classic Stash.
//   ⬆  click: let Whisparr choose an upgrade, or pick a release yourself from the last check
//      right-click / long-press / Shift+click: search the indexers now and pick a release
//      orange dot = file below your Whisparr quality target; blue badge = best quality found
//   🗑  delete now, tag it to delete later, or keep a scene already tagged for later
const PLUGIN_ID = "whisparr-upgrade";

async function gql(query, variables) {
  const r = await fetch("/graphql", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
const runOp = async (args) =>
  (await gql("mutation($p:ID!,$a:Map!){runPluginOperation(plugin_id:$p,args:$a)}", { p: PLUGIN_ID, a: args })).runPluginOperation;

let cfgCache = null, cfgAt = 0;
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

const getScene = async (id) =>
  (await gql("query($id:ID!){findScene(id:$id){id title tags{id name}}}", { id })).findScene;

async function tagId(name) {
  const d = await gql("query($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}}){tags{id}}}", { n: name });
  if (d.findTags.tags.length) return d.findTags.tags[0].id;
  return (await gql("mutation($n:String!){tagCreate(input:{name:$n}){id}}", { n: name })).tagCreate.id;
}
const setTags = (id, ids) => gql("mutation($id:ID!,$t:[ID!]){sceneUpdate(input:{id:$id,tag_ids:$t}){id}}", { id, t: ids });
async function addTag(scene, name) {
  const tid = await tagId(name);
  await setTags(scene.id, scene.tags.map((t) => t.id).filter((t) => t !== tid).concat(tid));
}
async function removeTag(scene, name) {
  await setTags(scene.id, scene.tags.filter((t) => t.name.toLowerCase() !== name.toLowerCase()).map((t) => t.id));
}
const hasTag = (s, n) => s.tags.some((t) => t.name.toLowerCase() === n.toLowerCase());
const requested = (s, c) => hasTag(s, c.upgrade) || hasTag(s, c.pending);

/* ---------- small helpers ---------- */
function flash(video, txt, ms) {
  const host = document.fullscreenElement || (video && video.parentElement) || document.body;
  let t = host.querySelector(":scope > .wu-flash");
  if (!t) {
    t = document.createElement("div");
    t.className = "wu-flash";
    t.style.cssText =
      "position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;" +
      "padding:6px 14px;border-radius:6px;font-size:15px;z-index:9999;pointer-events:none;transition:opacity .3s;max-width:90%";
    host.appendChild(t);
  }
  t.textContent = txt;
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.opacity = 0), ms || 2500);
}
const gb = (x) => (x == null ? "?" : x >= 10 ? Math.round(x) + " GB" : x >= 1 ? x.toFixed(1) + " GB" : Math.round(x * 1000) + " MB");
// "720p, 1.2 GB → 4K, 7.5 GB (+6.3 GB)"
function sizeLine(cur, c) {
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
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
};

// Quality status, cached 10 min. Checks are kept 24 h in this browser - shared with the
// classic-Stash buttons (same site, same storage), so a check made in either shows in both.
const statusCache = new Map();
async function status(id) {
  const c = statusCache.get(id);
  if (c && Date.now() - c.at < 600000) return c.data;
  const out = (await runOp({ mode: "status", ids: [id] })) || {};
  const data = out[id];
  if (!data || data.error) return null;
  statusCache.set(id, { at: Date.now(), data });
  return data;
}
function savedCheck(id, st) {
  try {
    const c = JSON.parse(localStorage.getItem("wu-check:" + id) || "null");
    if (!c || Date.now() - c.at > 86400000) return null;
    if (st && st.currentRes && c.data.currentRes !== st.currentRes) return null; // the file changed since
    return c;
  } catch (e) { return null; }
}

// A small dialog with several choices (confirm() only has OK/Cancel). Shown inside the
// fullscreen player when there is one, so it is never hidden behind it.
function choose(title, text, options) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#1d1620;color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:18px;width:min(420px,92vw);" +
      "font:14px system-ui,sans-serif;box-shadow:0 10px 40px #000c;";
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "font-weight:700;font-size:15px;margin-bottom:6px;overflow-wrap:anywhere";
    const p = document.createElement("div");
    p.textContent = text;
    p.style.cssText = "opacity:.8;margin-bottom:12px;white-space:pre-line";
    box.append(h, p);
    const finish = (v) => { back.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); } else e.stopPropagation(); };
    for (const o of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.label;
      b.style.cssText = "display:block;width:100%;margin-top:8px;padding:10px 12px;white-space:pre-line;line-height:1.35;border:0;border-radius:8px;cursor:pointer;text-align:left;" +
        "font:600 14px system-ui,sans-serif;color:#fff;background:" +
        (o.danger ? "#c23030" : o.main ? "var(--pink,#ff3e8a)" : "rgba(255,255,255,.1)");
      b.addEventListener("click", (e) => { e.stopPropagation(); finish(o.value); });
      box.appendChild(b);
    }
    ["click", "dblclick", "pointerdown"].forEach((t) => back.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === "click" && e.target === back) finish(null);
    }));
    document.addEventListener("keydown", key, true);
    back.appendChild(box);
    (document.fullscreenElement || document.body).appendChild(back);
  });
}

function button(txt, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "kb-btn is-icon is-ghost wu-btn";
  b.textContent = txt;
  b.style.cssText = "font-size:17px;line-height:1;font-weight:bold;position:relative;";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick(b, e);
  });
  return b;
}

/* ---------- ⬆ look ---------- */
function paintUp(b, s) {
  const { req, st, id } = s;
  const chk = savedCheck(id, st);
  let badge = b.querySelector(".wu-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "wu-badge";
    b.appendChild(badge);
  }
  badge.style.cssText = "position:absolute;top:0;right:-2px;font:700 9px/1 system-ui,sans-serif;padding:2px 3px;border-radius:6px;" +
    "pointer-events:none;color:#000;display:none";
  const lines = [req ? "Upgrade already requested" : "Ask Whisparr for a better-quality version"];
  if (st && st.currentRes) {
    const f = st.current + (st.sizeGB != null ? ", " + gb(st.sizeGB) : "") + (st.mbps ? ", ~" + st.mbps + " Mbps" : "");
    lines.push(st.targetRes ? "File: " + f + "  ·  your target: " + st.target
      : st.linked === false ? "File: " + f + "  ·  not linked to StashDB, so Whisparr can't look it up"
      : "File: " + f + "  ·  not in Whisparr");
  }
  if (chk) {
    const d = chk.data;
    if (d.error) lines.push("Last check failed: " + d.error);
    else if (d.better) {
      lines.push("Found " + d.better + " better release" + (d.better > 1 ? "s" : "") + " (" + ago(chk.at) + "):");
      lines.push("  " + sizeLine(st && st.sizeGB != null ? st : d, d));
      (d.top || []).slice(0, 3).forEach((r) => lines.push("  • " + relLines(r).join(" · ")));
    } else lines.push("No better version found (" + ago(chk.at) + ")");
  }
  if (st && st.movieId) lines.push("Right-click or Shift+click to search the indexers now");
  b.title = lines.join("\n");
  b.style.color = req ? "#4caf50" : "";
  if (req) return;
  if (chk && !chk.data.error && chk.data.better) {
    badge.textContent = chk.data.best;
    badge.style.display = "block";
    badge.style.background = "#00bcd4";
  } else if (st && st.below && !(chk && !chk.data.error && !chk.data.better)) {
    badge.textContent = "";
    Object.assign(badge.style, { display: "block", width: "7px", height: "7px", padding: "0", borderRadius: "50%", background: "#f5a623" });
  }
}
function paintDel(b, later) {
  b.style.color = later ? "#f5a623" : "";
  b.title = later ? "Tagged to delete later - click to delete now or keep it"
                  : "Delete scene + file (and exclude in Whisparr), or tag it to delete later";
}

export default function setup(stashui) {
  if (stashui.has && !stashui.has("slot:player.controls")) return;
  stashui.addSlot("player.controls", {
    id: "whisparr-upgrade",
    title: "Whisparr Upgrade",
    match: (ctx) => ctx.kind === "scene",
    mount(el, ctx) {
      let alive = true, checking = false;
      const state = { id: String(ctx.id), req: false, st: null };
      let up = null;

      const checkNow = async () => {
        if (checking) return;
        checking = true;
        flash(ctx.video, "Searching your indexers for a better version…", 60000);
        try {
          const data = await runOp({ mode: "check", id: state.id });
          if (!data) throw new Error("no answer from the plugin");
          try { localStorage.setItem("wu-check:" + state.id, JSON.stringify({ at: Date.now(), data })); } catch (e) {}
          if (alive && up) paintUp(up, state);
          flash(ctx.video, data.error ? "Check failed: " + data.error
            : data.better ? "Better version available: " + sizeLine(state.st && state.st.sizeGB != null ? state.st : data, data)
            : "No better version found right now", 4500);
          if (alive && !data.error && data.better) pick(data, Date.now());
        } catch (e) {
          flash(ctx.video, "Check failed: " + e.message, 4500);
        } finally {
          checking = false;
        }
      };

      const requestAuto = async (sc, c) => {
        await addTag(sc, c.upgrade);
        state.req = true;
        if (up) paintUp(up, state);
        flash(ctx.video, "Upgrade requested – Whisparr will search for a better version");
      };
      // Pick one release to download (like Whisparr's Interactive Search), or let Whisparr choose.
      const pick = async (data, at, scene) => {
        try {
          const c = await cfg();
          const sc = scene || await getScene(ctx.id);
          if (requested(sc, c)) return flash(ctx.video, "Upgrade already requested");
          const cur = state.st && state.st.sizeGB != null ? state.st : data;
          const opts = (data.top || []).filter((r) => r.guid).map((r) => ({ label: relLines(r).join("\n"), value: r }));
          opts.push({ label: "⬆  Let Whisparr choose (uses your quality profile)", value: "auto", main: true });
          opts.push({ label: "Cancel", value: null });
          const v = await choose(`Pick a version of "${sc.title || "this scene"}"`,
            "Your file: " + cur.current + ", " + gb(cur.sizeGB) + (cur.mbps ? ", ~" + cur.mbps + " Mbps" : "") +
            "   (checked " + ago(at) + ")\n⚠ = low bitrate for its resolution: often a heavy re-encode, an upscale or a shorter cut.\n" +
            "The one you pick downloads now and is merged into this scene when it arrives.", opts);
          if (!v) return;
          if (v === "auto") return requestAuto(sc, c);
          flash(ctx.video, "Sending " + v.label + " to the download client…", 10000);
          const out = await runOp({ mode: "grab", id: state.id, guid: v.guid, indexerId: v.indexerId });
          if (!out || out.error) return flash(ctx.video, "Couldn't grab it: " + ((out && out.error) || "no answer"), 5000);
          state.req = true;
          if (alive && up) paintUp(up, state);
          flash(ctx.video, "Downloading " + v.label + ", " + gb(v.sizeGB) + " – it will be merged into this scene", 5000);
        } catch (err) {
          alert("Upgrade failed: " + err.message);
        }
      };

      (async () => {
        const c = await cfg();
        if (!alive || c.hide) return;
        const s = await getScene(ctx.id);
        if (!alive || !s) return;
        state.req = requested(s, c);

        up = button("⬆", async (b, e) => {
          if (e.shiftKey) return checkNow();
          try {
            const sc = await getScene(ctx.id);
            if (requested(sc, c)) return flash(ctx.video, "Upgrade already requested");
            const chk = savedCheck(state.id, state.st);
            if (chk && !chk.data.error && chk.data.better) return pick(chk.data, chk.at, sc);
            const found = chk && !chk.data.error ? `\n\nLast check (${ago(chk.at)}) found nothing better - Whisparr will keep looking.` : "";
            const v = await choose(`Upgrade "${sc.title || "this scene"}"?`,
              "Whisparr will look for a better-quality version. When it downloads, it is merged into this scene, keeping markers, rating and history." + found,
              [{ label: "⬆  Let Whisparr choose (uses your quality profile)", value: "auto", main: true },
               { label: "🔍  Search now and pick a release myself", value: "search" },
               { label: "Cancel", value: null }]);
            if (v === "search") return checkNow();
            if (v === "auto") await requestAuto(sc, c);
          } catch (err) {
            alert("Upgrade request failed: " + err.message);
          }
        });
        // right-click / long-press: search the indexers now
        up.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); checkNow(); });
        paintUp(up, state);
        el.appendChild(up);
        status(state.id).then((st) => { if (alive && st) { state.st = st; paintUp(up, state); } }).catch(() => {});

        if (c.enableDelete) {
          const del = button("🗑", async (b) => {
            try {
              const sc = await getScene(ctx.id);
              const later = hasTag(sc, c.later);
              const pick = await choose(`Delete "${sc.title || "this scene"}"?`,
                (later ? "This scene is already tagged to delete later.\n\n" : "") +
                "Deleting now removes the scene and its file, and excludes it in Whisparr so it is never downloaded again." +
                (later ? "" : "\nTagging only marks it - nothing is deleted, and you can find it later by filtering on the tag."),
                [{ label: "🗑  Delete now - scene, file and Whisparr exclusion", value: "now", danger: true },
                 later ? { label: `↩  Keep it - remove the "${c.later}" tag`, value: "untag" }
                       : { label: `🏷  Tag it to delete later ("${c.later}")`, value: "later", main: true },
                 { label: "Cancel", value: null }]);
              if (!pick) return;
              if (pick === "later" || pick === "untag") {
                if (pick === "later") await addTag(sc, c.later);
                else await removeTag(sc, c.later);
                paintDel(b, pick === "later");
                flash(ctx.video, pick === "later" ? `Tagged "${c.later}" - nothing deleted` : `Removed the "${c.later}" tag`);
                return;
              }
              if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
              if (ctx.video) ctx.video.pause();
              await addTag(sc, c.del);
              if (history.length > 1) history.back();
              else location.hash = "#/scenes";
            } catch (err) {
              alert("Delete failed: " + err.message);
            }
          });
          paintDel(del, hasTag(s, c.later));
          el.appendChild(del);
        }
      })().catch(() => {});
      return () => {
        alive = false;
        el.innerHTML = "";
      };
    },
  });
}
