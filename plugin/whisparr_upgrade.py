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


def main():
    data = json.loads(sys.stdin.read())
    stash = StashInterface(data["server_connection"])
    hook = (data.get("args") or {}).get("hookContext") or {}
    if not hook.get("id"):
        done("no hook context")
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
