"""Whisparr Upgrade - Stash plugin.

Scene.Update.Post
  * scene tagged UPGRADE_TAG -> monitor it in Whisparr and start a search; swap the tag to PENDING_TAG.
  * scene tagged DELETE_TAG (only when ENABLE_DELETE is on) -> remove it from Whisparr with an
    import exclusion (never re-downloaded), then delete the scene, its file and generated files.
Scene.Create.Post
  * a new file whose path contains "[<stashdb scene id>]" (Whisparr's folder naming) and whose
    original scene is PENDING -> merge the new scene into the original (keeps markers, rating,
    play history, tags), drop the PENDING tag, and stop monitoring the scene in Whisparr
    (unless KEEP_MONITORING is on) so it isn't upgraded again or re-downloaded if deleted.

Run from the browser (runPluginOperation, no hook):
  * mode "status", ids [...] -> each scene's file quality vs the quality profile's target in Whisparr.
  * mode "check", id        -> ask Whisparr to search the indexers now and report better releases
                               (with size, bitrate and a low-bitrate warning). Nothing is downloaded.
  * mode "grab", id, guid, indexerId -> download that one release (as Whisparr's Interactive Search
                               does), and mark the scene Upgrade Requested so it is merged on import.

Requires: stashapp-tools (pip install stashapp-tools), which also installs requests.
"""
import json
import re
import sys

import requests
import stashapi.log as log
from stashapi.stashapp import StashInterface

PLUGIN_ID = "whisparr-upgrade"
UUID_RE = re.compile(r"\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]")
FRAG = "id title tags { id name } stash_ids { endpoint stash_id } files { path }"


def done(msg="ok"):
    print(json.dumps({"output": msg}))
    sys.exit(0)


def stashdb_id(scene):
    for s in scene.get("stash_ids") or []:
        if "stashdb.org" in s["endpoint"]:
            return s["stash_id"]
    return None


def tag_id(stash, name):
    return stash.find_tag(name, create=True)["id"]


def set_tags(stash, scene, remove_names, add_id=None):
    keep = [t["id"] for t in scene["tags"] if t["name"].lower() not in remove_names]
    if add_id and add_id not in keep:
        keep.append(add_id)
    stash.update_scene({"id": scene["id"], "tag_ids": keep})


def whisparr_movies(cfg, sid):
    h = {"X-Api-Key": cfg["key"]}
    r = requests.get(f"{cfg['url']}/api/v3/movie", params={"stashId": sid}, headers=h, timeout=30)
    r.raise_for_status()
    return [m for m in r.json() if m.get("stashId") == sid]


def request_upgrade(stash, cfg, scene):
    sid = stashdb_id(scene)
    if not sid:
        log.warning(f"[Upgrade] '{scene['title']}' has no StashDB link - can't look it up in Whisparr")
        return
    movies = whisparr_movies(cfg, sid)
    if not movies:
        log.warning(f"[Upgrade] '{scene['title']}' isn't in Whisparr yet - add it to Whisparr first")
        return
    h = {"X-Api-Key": cfg["key"]}
    mid = movies[0]["id"]
    requests.put(f"{cfg['url']}/api/v3/movie/editor", json={"movieIds": [mid], "monitored": True},
                 headers=h, timeout=30).raise_for_status()
    requests.post(f"{cfg['url']}/api/v3/command", json={"name": "MoviesSearch", "movieIds": [mid]},
                  headers=h, timeout=30).raise_for_status()
    set_tags(stash, scene, {cfg["upgrade"].lower()}, tag_id(stash, cfg["pending"]))
    log.info(f"[Upgrade] Whisparr is searching for a better version of '{scene['title']}'")


def delete_scene(stash, cfg, scene):
    sid = stashdb_id(scene)
    if sid and cfg["key"]:
        try:
            h = {"X-Api-Key": cfg["key"]}
            movies = whisparr_movies(cfg, sid)
            for m in movies:
                requests.delete(f"{cfg['url']}/api/v3/movie/{m['id']}",
                                params={"deleteFiles": "false", "addImportExclusion": "true"},
                                headers=h, timeout=30).raise_for_status()
            if movies:
                log.info(f"[Delete] Removed '{scene['title']}' from Whisparr and added it to the exclusion list")
        except Exception as e:
            log.warning(f"[Delete] Couldn't exclude '{scene['title']}' in Whisparr: {e}")
    stash.call_GQL(
        "mutation($i: SceneDestroyInput!) { sceneDestroy(input: $i) }",
        {"i": {"id": scene["id"], "delete_file": True, "delete_generated": True}},
    )
    log.info(f"[Delete] Deleted scene '{scene['title']}' and its file")


def merge_upgraded(stash, cfg, new_scene):
    ids = set()
    for f in new_scene.get("files") or []:
        ids.update(UUID_RE.findall(f["path"]))
    if not ids:
        return
    pending = cfg["pending"].lower()
    for sid in ids:
        found = stash.find_scenes(
            {"stash_id_endpoint": {"stash_id": sid, "modifier": "EQUALS"}}, fragment=FRAG
        ) or []
        originals = [s for s in found if s["id"] != new_scene["id"]
                     and any(t["name"].lower() == pending for t in s["tags"])]
        if not originals:
            continue
        orig = originals[0]
        stash.call_GQL(
            "mutation($i: SceneMergeInput!) { sceneMerge(input: $i) { id } }",
            {"i": {"source": [new_scene["id"]], "destination": orig["id"]}},
        )
        orig = stash.find_scene(orig["id"], fragment=FRAG)
        set_tags(stash, orig, {pending})
        log.info(f"[Upgrade] Merged upgraded file into '{orig['title']}' (old file entry is removed on next Clean)")
        if not cfg["keep_monitoring"] and cfg["key"]:
            try:
                movies = whisparr_movies(cfg, sid)
                if movies:
                    requests.put(f"{cfg['url']}/api/v3/movie/editor",
                                 json={"movieIds": [m["id"] for m in movies], "monitored": False},
                                 headers={"X-Api-Key": cfg["key"]}, timeout=30).raise_for_status()
                    log.info(f"[Upgrade] Stopped monitoring '{orig['title']}' in Whisparr - the upgrade is done")
            except Exception as e:
                log.warning(f"[Upgrade] Couldn't stop monitoring '{orig['title']}' in Whisparr: {e}")
        return


NOMINAL = [2160, 1440, 1080, 720, 576, 480, 360, 240]
FRAG_FILES = FRAG.replace("files { path }", "files { path height width size duration }")
# Below these Mbps a release is flagged "low bitrate" (likely a heavy re-encode, upscale or short cut).
LOW_MBPS = {2160: 12, 1440: 7, 1080: 4, 720: 2, 576: 1.2, 480: 1}
_profiles = {}


def nominal(height, width=0):
    """Treat 1920x800 or 1920x1072 as 1080p, etc."""
    h = max(height or 0, int((width or 0) * 9 / 16))
    for n in NOMINAL:
        if h >= n * 0.9:
            return n
    return h


def res_label(res, name=None):
    if res >= 2160:
        return f"{round(res * 16 / 9 / 1000)}K"   # 2160 -> 4K, 2880 -> 5K, 3160 -> 6K, 4320 -> 8K
    return f"{res}p" if res else (name or "?")


def profile_target(cfg, pid):
    """(name, resolution) of the quality profile's cutoff - the quality Whisparr upgrades up to."""
    if pid not in _profiles:
        r = requests.get(f"{cfg['url']}/api/v3/qualityprofile/{pid}",
                         headers={"X-Api-Key": cfg["key"]}, timeout=30)
        r.raise_for_status()
        p = r.json()
        cut, name, res = p.get("cutoff"), None, 0
        for it in p.get("items") or []:
            q = it.get("quality")
            if q and q.get("id") == cut:
                name, res = q.get("name"), q.get("resolution") or 0
            elif not q and it.get("id") == cut:
                kids = [k.get("quality") or {} for k in it.get("items") or []]
                name = it.get("name")
                res = max([k.get("resolution") or 0 for k in kids] or [0])
        _profiles[pid] = (name, res)
    return _profiles[pid]


def scene_status(stash, cfg, scene_id):
    scene = stash.find_scene(scene_id, fragment=FRAG_FILES)
    if not scene:
        return {"error": "scene not found"}
    files = scene.get("files") or []
    cur = max([nominal(f.get("height"), f.get("width")) for f in files] or [0])
    size = max([f.get("size") or 0 for f in files] or [0])
    dur = max([f.get("duration") or 0 for f in files] or [0])
    out = {"currentRes": cur, "current": res_label(cur), "sizeGB": round(size / 1e9, 2),
           "durationSec": round(dur), "mbps": round(size * 8 / dur / 1e6, 1) if dur else None}
    sid = stashdb_id(scene)
    if not sid:
        out["linked"] = False
        return out
    movies = whisparr_movies(cfg, sid)
    if not movies:
        out["inWhisparr"] = False
        return out
    m = movies[0]
    out["movieId"] = m["id"]
    out["monitored"] = bool(m.get("monitored"))
    tname, tres = profile_target(cfg, m.get("qualityProfileId"))
    out["target"], out["targetRes"] = res_label(tres, tname), tres
    # Below target = the file Stash actually has is a lower resolution than the profile's target.
    # (Whisparr's own "cutoff not met" flag can disagree when its record of the file is out of date.)
    out["below"] = bool(tres) and bool(cur) and cur < tres
    return out


def search_releases(cfg, movie_id):
    r = requests.get(f"{cfg['url']}/api/v3/release", params={"movieId": movie_id},
                     headers={"X-Api-Key": cfg["key"]}, timeout=240)
    r.raise_for_status()
    return r.json()


def indexer_priorities(cfg):
    """{indexerId: priority} from Whisparr (1 = most preferred, 25 = default, 50 = least)."""
    try:
        r = requests.get(f"{cfg['url']}/api/v3/indexer", headers={"X-Api-Key": cfg["key"]}, timeout=30)
        r.raise_for_status()
        return {i.get("id"): i.get("priority", 25) for i in r.json()}
    except Exception:
        return {}


def check_releases(stash, cfg, scene_id):
    st = scene_status(stash, cfg, scene_id)
    if "movieId" not in st:
        return dict(st, error="This scene isn't linked to Whisparr" if st.get("linked") is False
                    else "This scene isn't in Whisparr")
    dur = st.get("durationSec") or 0
    prio = indexer_priorities(cfg)
    better = []
    for rel in search_releases(cfg, st["movieId"]):
        q = (rel.get("quality") or {}).get("quality") or {}
        res = q.get("resolution") or 0
        if res <= st["currentRes"]:
            continue
        if rel.get("protocol") == "torrent" and (rel.get("seeders") or 0) < 1:
            continue
        size = rel.get("size") or 0
        mbps = round(size * 8 / dur / 1e6, 1) if dur and size else None
        better.append({
            "title": rel.get("title"),
            "quality": q.get("name"),
            "res": res,
            "label": res_label(res),
            "sizeGB": round(size / 1e9, 1),
            "mbps": mbps,
            "low": bool(mbps is not None and mbps < LOW_MBPS.get(nominal(res), 0)),
            "indexer": rel.get("indexer"),
            "indexerId": rel.get("indexerId"),
            "priority": prio.get(rel.get("indexerId"), 25),
            "guid": rel.get("guid"),
            "protocol": rel.get("protocol"),
            "seeders": rel.get("seeders"),
            "approved": bool(rel.get("approved")),
            "rejection": ((rel.get("rejections") or [None])[0]),
        })
    # Highest resolution first; then normal bitrate before low, then your Whisparr indexer priority
    # (1 = most preferred, like Whisparr itself), then larger, then more seeders.
    better.sort(key=lambda b: (-b["res"], b["low"], b["priority"], -b["sizeGB"], -(b["seeders"] or 0)))
    top = better[0] if better else None
    return dict(st, better=len(better), bestRes=top["res"] if top else 0, best=top["label"] if top else None,
                bestSizeGB=top["sizeGB"] if top else None, bestMbps=top["mbps"] if top else None,
                bestLow=top["low"] if top else False, top=better[:40])


def grab_release(stash, cfg, scene_id, guid, indexer_id):
    """Download one specific release, like Whisparr's Interactive Search, then mark the scene pending."""
    scene = stash.find_scene(scene_id, fragment=FRAG)
    if not scene:
        return {"error": "scene not found"}
    st = scene_status(stash, cfg, scene_id)
    if "movieId" not in st:
        return {"error": "This scene isn't in Whisparr"}
    h = {"X-Api-Key": cfg["key"]}
    body = {"guid": guid, "indexerId": indexer_id}

    def push():
        return requests.post(f"{cfg['url']}/api/v3/release", json=body, headers=h, timeout=120)

    r = push()
    if r.status_code >= 400:
        # Whisparr only keeps search results for a while - search again, then grab the same release.
        found = [x for x in search_releases(cfg, st["movieId"]) if x.get("guid") == guid]
        if not found:
            return {"error": "That release is no longer available - run the check again"}
        body["indexerId"] = found[0].get("indexerId", indexer_id)
        r = push()
    if r.status_code >= 400:
        try:
            msg = r.json()
            msg = msg.get("message") or msg[0].get("errorMessage") if isinstance(msg, (dict, list)) else r.text
        except Exception:
            msg = r.text
        return {"error": f"Whisparr refused it: {str(msg)[:200]}"}
    set_tags(stash, scene, {cfg["upgrade"].lower()}, tag_id(stash, cfg["pending"]))
    log.info(f"[Upgrade] Sent the chosen release for '{scene['title']}' to the download client")
    return {"ok": True}


def main():
    data = json.loads(sys.stdin.read())
    stash = StashInterface(data["server_connection"])
    args = data.get("args") or {}
    hook = args.get("hookContext") or {}
    raw = (stash.get_configuration().get("plugins") or {}).get(PLUGIN_ID, {})
    cfg = {
        "url": (raw.get("WHISPARR_URL") or "http://localhost:6969").rstrip("/"),
        "key": raw.get("WHISPARR_KEY") or "",
        "upgrade": raw.get("UPGRADE_TAG") or "Upgrade",
        "pending": raw.get("PENDING_TAG") or "Upgrade Requested",
        "delete": raw.get("DELETE_TAG") or "Delete",
        "enable_delete": bool(raw.get("ENABLE_DELETE")),
        "keep_monitoring": bool(raw.get("KEEP_MONITORING")),
    }
    if not hook.get("id"):
        mode = args.get("mode")
        if mode in ("status", "check", "grab"):
            if not cfg["key"]:
                done({"error": "Whisparr API key not set in the plugin settings"})
            try:
                if mode == "status":
                    out = {}
                    for i in (args.get("ids") or [])[:50]:
                        try:
                            out[str(i)] = scene_status(stash, cfg, i)
                        except Exception as e:
                            out[str(i)] = {"error": str(e)}
                    done(out)
                if mode == "grab":
                    done(grab_release(stash, cfg, args.get("id"), args.get("guid"), args.get("indexerId")))
                done(check_releases(stash, cfg, args.get("id")))
            except Exception as e:
                done({"error": str(e)})
        done("no hook context")
    scene = stash.find_scene(hook["id"], fragment=FRAG)
    if not scene:
        done("scene not found")
    names = {t["name"].lower() for t in scene["tags"]}
    try:
        if hook.get("type", "").startswith("Scene.Create"):
            merge_upgraded(stash, cfg, scene)
        elif cfg["delete"].lower() in names:
            if cfg["enable_delete"]:
                delete_scene(stash, cfg, scene)
            else:
                log.warning(f"[Delete] '{scene['title']}' has the Delete tag, but delete is turned off in the plugin settings - nothing deleted")
        elif cfg["upgrade"].lower() in names:
            if not cfg["key"]:
                log.error("[Upgrade] Whisparr API key not set in plugin settings")
            else:
                request_upgrade(stash, cfg, scene)
    except Exception as e:  # never break the hook chain
        log.error(f"[Whisparr Upgrade] {e}")
    done()


if __name__ == "__main__":
    main()
