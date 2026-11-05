// Whisparr Upgrade - Stash UI extension: ⬆ and 🗑 in Stash UI's player control bar.
// Loaded by Stash UI from /plugin/whisparr-upgrade/assets/stashui.js. The server side
// (Whisparr search, merge, delete + exclusion) is the same plugin as in classic Stash.
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

let cfgCache = null, cfgAt = 0;
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

const getScene = async (id) =>
  (await gql("query($id:ID!){findScene(id:$id){id title tags{id name}}}", { id })).findScene;

async function tagId(name) {
  const d = await gql("query($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}}){tags{id}}}", { n: name });
  if (d.findTags.tags.length) return d.findTags.tags[0].id;
  return (await gql("mutation($n:String!){tagCreate(input:{name:$n}){id}}", { n: name })).tagCreate.id;
}

async function addTag(scene, name) {
  const tid = await tagId(name);
  const ids = scene.tags.map((t) => t.id).filter((t) => t !== tid).concat(tid);
  await gql("mutation($id:ID!,$t:[ID!]){sceneUpdate(input:{id:$id,tag_ids:$t}){id}}", { id: scene.id, t: ids });
}

const requested = (s, c) => {
  const n = s.tags.map((t) => t.name.toLowerCase());
  return n.includes(c.upgrade.toLowerCase()) || n.includes(c.pending.toLowerCase());
};

function flash(video, txt) {
  const host = (video && video.parentElement) || document.body;
  let t = host.querySelector(":scope > .wu-flash");
  if (!t) {
    t = document.createElement("div");
    t.className = "wu-flash";
    t.style.cssText =
      "position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;" +
      "padding:6px 14px;border-radius:6px;font-size:15px;z-index:9999;pointer-events:none;transition:opacity .3s";
    host.appendChild(t);
  }
  t.textContent = txt;
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.opacity = 0), 2500);
}

function button(txt, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "kb-btn is-icon is-ghost wu-btn";
  b.textContent = txt;
  b.title = title;
  b.style.cssText = "font-size:17px;line-height:1;font-weight:bold;";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick(b);
  });
  return b;
}

function look(b, req) {
  b.style.color = req ? "#4caf50" : "";
  b.title = req ? "Upgrade already requested" : "Ask Whisparr for a better-quality version";
}

export default function setup(stashui) {
  if (stashui.has && !stashui.has("slot:player.controls")) return;
  stashui.addSlot("player.controls", {
    id: "whisparr-upgrade",
    title: "Whisparr Upgrade",
    match: (ctx) => ctx.kind === "scene",
    mount(el, ctx) {
      let alive = true;
      (async () => {
        const c = await cfg();
        if (!alive || c.hide) return;
        const s = await getScene(ctx.id);
        if (!alive || !s) return;
        const up = button("⬆", "", async (b) => {
          try {
            const sc = await getScene(ctx.id);
            if (requested(sc, c)) return flash(ctx.video, "Upgrade already requested");
            if (!confirm(`Ask Whisparr to find a better-quality version of "${sc.title || "this scene"}"?\n\nWhen it downloads, it is merged into this scene, keeping markers, rating and history.`)) return;
            await addTag(sc, c.upgrade);
            look(b, true);
            flash(ctx.video, "Upgrade requested – Whisparr will search for a better version");
          } catch (e) {
            alert("Upgrade request failed: " + e.message);
          }
        });
        look(up, requested(s, c));
        el.appendChild(up);
        if (c.enableDelete) {
          el.appendChild(
            button("🗑", "Delete scene + file (and exclude in Whisparr)", async () => {
              try {
                const sc = await getScene(ctx.id);
                if (!confirm(`Delete "${sc.title || "this scene"}" and its file?\n\nIt will also be excluded in Whisparr so it is never downloaded again.`)) return;
                if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
                if (ctx.video) ctx.video.pause();
                await addTag(sc, c.del);
                if (history.length > 1) history.back();
                else location.hash = "#/scenes";
              } catch (e) {
                alert("Delete failed: " + e.message);
              }
            })
          );
        }
      })().catch(() => {});
      return () => {
        alive = false;
        el.innerHTML = "";
      };
    },
  });
}
