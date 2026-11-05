/* Whisparr Upgrade - scene page + player buttons.
   ⬆  adds the Upgrade tag (the plugin then asks Whisparr for a better version).
   🗑  adds the Delete tag (only shown when "Enable delete" is on in the plugin settings). */
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
      enableDelete: !!raw.ENABLE_DELETE,
      hide: !!raw.HIDE_BUTTONS,
    };
    cfgAt = Date.now();
    return cfgCache;
  }

  const sceneId = () => (location.pathname.match(/^\/scenes\/(\d+)/) || [])[1];

  function toast(txt) {
    const host = document.querySelector(".scene-player-container .video-js") || document.body;
    let t = host.querySelector(".wu-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "wu-toast";
      t.style.cssText =
        "position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);" +
        "color:#fff;padding:5px 14px;border-radius:4px;font-size:15px;z-index:9999;pointer-events:none;transition:opacity .3s";
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

  async function upgrade(btns) {
    const id = sceneId();
    if (!id) return;
    try {
      const c = await cfg();
      const s = await getScene(id);
      if (isRequested(s, c)) {
        toast("Upgrade already requested for this scene");
        return;
      }
      if (!confirm(`Ask Whisparr to find a better-quality version of "${s.title || "this scene"}"?\n\nWhen it downloads, it is merged into this scene, keeping markers, rating and history.`)) return;
      await addTag(id, s, c.upgrade);
      btns.forEach((b) => look(b, true));
      toast("Upgrade requested - Whisparr will search for a better version");
    } catch (e) {
      alert("Upgrade request failed: " + e.message);
    }
  }

  async function del() {
    const id = sceneId();
    if (!id) return;
    try {
      const c = await cfg();
      if (!c.enableDelete) return;
      const s = await getScene(id);
      if (!confirm(`Delete "${s.title || "this scene"}" and its file?\n\nIt will also be excluded in Whisparr so it is never downloaded again.`)) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      await addTag(id, s, c.del);
      if (history.length > 1) history.back();
      else location.assign("/scenes");
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  function look(b, requested) {
    b.style.color = requested ? "#4caf50" : "";
    b.title = requested ? "Upgrade already requested" : "Ask Whisparr for a better-quality version";
  }

  function mk(cls, txt, onClick, player) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = (player ? "vjs-control vjs-button " : "minimal btn btn-secondary ") + cls;
    b.textContent = txt;
    b.style.cssText = player ? "font-size:1.6em;cursor:pointer;width:2em;font-weight:bold;" : "font-size:1em;padding:0 .45em;line-height:1.6;";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  let busy = false;
  async function inject() {
    const id = sceneId();
    if (!id || busy) return;
    const bar = document.querySelector(".scene-player-container .vjs-control-bar");
    // Scene-page buttons go in the line under the title, between the date and
    // the quality (e.g. "29.97 fps | 1080p"); fall back to the toolbar.
    const tb = document.querySelector(".scene-subheader") || document.querySelector(".scene-toolbar");
    const need =
      (bar && (!bar.querySelector(".wu-up") || bar.dataset.wuSid !== id)) ||
      (tb && (!tb.querySelector(".wu-up") || tb.dataset.wuSid !== id));
    if (!need) return;
    busy = true;
    try {
      const c = await cfg();
      if (c.hide) return;
      const s = await getScene(id);
      const req = isRequested(s, c);
      const ups = [];
      for (const [host, player] of [[bar, true], [tb, false]]) {
        if (!host) continue;
        host.querySelectorAll(".wu-btn").forEach((x) => x.remove());
        host.dataset.wuSid = id;
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
        const up = mk("wu-btn wu-up", "⬆", () => upgrade(ups), player);
        look(up, req);
        ups.push(up);
        wrap.insertBefore(up, ref);
        if (c.enableDelete) {
          const d = mk("wu-btn wu-del", "🗑", del, player);
          d.title = "Delete scene + file (and exclude in Whisparr)";
          wrap.insertBefore(d, ref);
        }
      }
    } catch (e) {
      /* ignore - try again on next change */
    } finally {
      busy = false;
    }
  }

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
