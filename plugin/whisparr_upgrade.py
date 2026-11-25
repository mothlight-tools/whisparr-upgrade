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
  * mode "grab", id, guid, indexerId[, override] -> download that one release (as Whisparr's Interactive
                               Search does), and mark the scene Upgrade Requested so it is merged on import.
                               override = a release Whisparr couldn't match to the scene itself.
  * mode "maintain"         -> run every few minutes by the buttons: imports downloads you picked that
                               Whisparr holds back for a Manual Import, and (if set) gives up on upgrade
                               requests older than "Give up after N days".

Requires: stashapp-tools (pip install stashapp-tools), which also installs requests.
"""
import fcntl
import json
import os
import re
import sys
import time

import requests
import stashapi.log as log
from stashapi.stashapp import StashInterface

PLUGIN_ID = "whisparr-upgrade"
UUID_RE = re.compile(r"\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]")
HERE = os.path.dirname(os.path.abspath(__file__))
PICKS = os.path.join(HERE, ".picked-grabs.json")        # releases picked here, imported by "maintain"
REQUESTS = os.path.join(HERE, ".upgrade-requests.json")  # when each scene's upgrade was requested
PICK_DAYS = 14   # how long a picked download is watched for its import
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


def whisparr(cfg, method, path, body=None):
    r = requests.request(method, cfg["url"] + path, json=body, headers={"X-Api-Key": cfg["key"]}, timeout=60)
    r.raise_for_status()
    return r.json() if r.text else None


def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def _save(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def note_request(scene_id):
    """Remember when a scene's upgrade was asked for (used by "Give up after N days")."""
    req = _load(REQUESTS, {})
    req[str(scene_id)] = time.time()
    _save(REQUESTS, req)


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
    try:
        st = scene_status(stash, cfg, scene["id"])
        if st.get("below") is False and st.get("targetRes"):
            log.warning(f"[Upgrade] '{scene['title']}' is already {st['current']}, which meets your Whisparr target "
                        f"({st['target']}) - Whisparr won't download a better version on its own. Use 'Search now and "
                        "pick a release myself' on the ⬆ button, or raise the cutoff in the quality profile.")
    except Exception:
        pass
    requests.put(f"{cfg['url']}/api/v3/movie/editor", json={"movieIds": [mid], "monitored": True},
                 headers=h, timeout=30).raise_for_status()
    requests.post(f"{cfg['url']}/api/v3/command", json={"name": "MoviesSearch", "movieIds": [mid]},
                  headers=h, timeout=30).raise_for_status()
    set_tags(stash, scene, {cfg["upgrade"].lower()}, tag_id(stash, cfg["pending"]))
    note_request(scene["id"])
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


# ---------- does a release look like this scene? (same rules as StashPicker) ----------
PACK_RE = re.compile(r"\b(pack|megapack|collection|parts?\s*\d+\s*(-|–|&|,|and|to)\s*\d+|\d+\s*(scenes|videos|clips|episodes))\b", re.I)
HIGH_MBPS = {2160: 120, 1440: 70, 1080: 40, 720: 20, 576: 12, 480: 10}   # way above one normal scene
LIKELY = 4   # likeness score from which a release Whisparr couldn't match is flagged "likely this scene"
BITRATE_UP = 1.5   # same resolution counts as better when your file is low bitrate and this is 1.5x or more
_STOP = {"the", "and", "with", "her", "his", "for", "xxx", "from", "gets", "into", "your", "that", "this", "step"}
_PART_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "i": 1, "ii": 2, "iii": 3, "iv": 4}


def _words(s):
    return re.findall(r"[a-z0-9]+", (s or "").lower())


def _close(a, b):
    """Same word, or one letter added/removed/changed (Lily ~ Lilly) for words of 4+ letters."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4 or abs(len(a) - len(b)) > 1:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 1


def _part(text):
    """'Part Two' / 'Pt. 2' / 'Part II' -> 2 (None when the name has no part number)."""
    m = re.search(r"\b(?:part|pt)\.?\s*(\d+|one|two|three|four|five|iv|iii|ii|i)\b", (text or "").lower())
    if not m:
        return None
    v = m.group(1)
    return int(v) if v.isdigit() else _PART_WORDS[v]


def scene_hint(mv):
    """What a release name for this scene usually contains: date, studio, performers, title words."""
    d = (mv.get("releaseDate") or "")[:10].split("-")
    performers = [w for w in (_words(n) for n in (mv.get("performerNames") or [])) if w]
    pwords = {w for p in performers for w in p}
    return {
        "dates": [f"{d[0][2:]} {d[1]} {d[2]}", f"{d[0]} {d[1]} {d[2]}"] if len(d) == 3 else [],
        "studio": "".join(_words(mv.get("studioTitle"))),
        "performers": performers,
        "part": _part(mv.get("title")),
        "title": [w for w in _words(mv.get("title"))
                  if len(w) >= 4 and w not in _STOP and not any(_close(w, p) for p in pwords)],
    }


def likeness(hint, release_title):
    """Points for how much a release name looks like this scene: date 3, studio 2, each performer 2, title up to 2."""
    words = _words(release_title)
    joined, compact = " " + " ".join(words) + " ", "".join(words)
    score = 0
    if any(f" {d} " in joined for d in hint["dates"]):
        score += 3
    if hint["studio"] and hint["studio"] in compact:
        score += 2
    for p in hint["performers"][:4]:
        if all(any(_close(pw, w) for w in words) for pw in p):
            score += 2
    if hint.get("part"):   # "Part One" vs "Part Two" of the same scene: the number decides
        p = _part(release_title)
        if p:
            score += 2 if p == hint["part"] else -3
    if hint["title"]:
        hit = sum(1 for tw in hint["title"] if any(_close(tw, w) for w in words)) / len(hint["title"])
        score += 2 if hit >= 0.6 else 1 if hit >= 0.3 else 0
    return score


def _reason(x):
    return x[:-2].rstrip() if x.endswith("[]") else x


def check_releases(stash, cfg, scene_id):
    """Search the indexers now. Releases Whisparr matched to this scene and that beat your file go in "top";
    better-quality releases Whisparr couldn't match (often the same scene under a network name or a re-release
    date) go in "others", most alike first, flagged likely when the name scores >= LIKELY."""
    st = scene_status(stash, cfg, scene_id)
    if "movieId" not in st:
        return dict(st, error="This scene isn't linked to Whisparr" if st.get("linked") is False
                    else "This scene isn't in Whisparr")
    dur = st.get("durationSec") or 0
    cur = st["currentRes"]
    cur_mbps = st.get("mbps")
    cur_low = bool(cur_mbps is not None and cur_mbps < LOW_MBPS.get(nominal(cur), 0))
    prio = indexer_priorities(cfg)
    try:
        mv = whisparr(cfg, "GET", f"/api/v3/movie/{int(st['movieId'])}") or {}
    except Exception:
        mv = {}
    hint = scene_hint(mv)
    top, others = [], []
    for rel in search_releases(cfg, st["movieId"]):
        q = (rel.get("quality") or {}).get("quality") or {}
        res = q.get("resolution") or 0
        if rel.get("protocol") == "torrent" and (rel.get("seeders") or 0) < 1:
            continue
        size = rel.get("size") or 0
        title = rel.get("title") or ""
        mbps = round(size * 8 / dur / 1e6, 1) if dur and size else None
        low = bool(mbps is not None and mbps < LOW_MBPS.get(nominal(res), 0))
        pack = bool(PACK_RE.search(title) or (mbps and mbps > HIGH_MBPS.get(nominal(res), 999)))
        # Better = higher resolution, or the same resolution when your file is low bitrate and this one is
        # a normal bitrate and clearly higher (a pack's size says nothing about one scene's bitrate).
        bitrate_up = (nominal(res) == nominal(cur) and cur_low and not low and not pack
                      and mbps is not None and cur_mbps and mbps >= cur_mbps * BITRATE_UP)
        if res <= cur and not bitrate_up:
            continue
        match = rel.get("mappedMovieId") == int(st["movieId"])
        row = {
            "title": title,
            "quality": q.get("name"),
            "res": res,
            "label": res_label(res),
            "sizeGB": round(size / 1e9, 1),
            "mbps": mbps,
            "low": low,
            "pack": pack,
            "bitrateUp": bool(bitrate_up),
            "indexer": rel.get("indexer"),
            "indexerId": rel.get("indexerId"),
            "priority": prio.get(rel.get("indexerId"), 25),
            "guid": rel.get("guid"),
            "protocol": rel.get("protocol"),
            "seeders": rel.get("seeders"),
            "approved": bool(rel.get("approved")),
            "match": match,
            "score": likeness(hint, title),
            "reasons": [_reason(x) for x in (rel.get("rejections") or [])],
            "rejection": ((rel.get("rejections") or [None])[0]),
        }
        row["likely"] = not match and row["score"] >= LIKELY
        (top if match else others).append(row)
    # Highest resolution first; then normal bitrate before low, then your Whisparr indexer priority
    # (1 = most preferred, like Whisparr itself), then larger, then more seeders.
    rank = lambda b: (-b["res"], b["low"], b["pack"], b["priority"], -b["sizeGB"], -(b["seeders"] or 0))
    top.sort(key=rank)
    others.sort(key=lambda b: (-b["score"],) + rank(b))
    best = top[0] if top else None
    scene = {"title": mv.get("title"), "studio": mv.get("studioTitle"), "date": (mv.get("releaseDate") or "")[:10],
             "performers": mv.get("performerNames") or []}
    return dict(st, better=len(top), bestRes=best["res"] if best else 0, best=best["label"] if best else None,
                bestSizeGB=best["sizeGB"] if best else None, bestMbps=best["mbps"] if best else None,
                bestLow=best["low"] if best else False, bestBitrateUp=best["bitrateUp"] if best else False,
                curLow=cur_low, top=top[:40], others=others[:40],
                likely=sum(1 for o in others if o["likely"]), scene=scene)


def grab_release(stash, cfg, scene_id, guid, indexer_id, override=False):
    """Download one specific release, like Whisparr's Interactive Search, then mark the scene pending."""
    scene = stash.find_scene(scene_id, fragment=FRAG)
    if not scene:
        return {"error": "scene not found"}
    st = scene_status(stash, cfg, scene_id)
    if "movieId" not in st:
        return {"error": "This scene isn't in Whisparr"}
    h = {"X-Api-Key": cfg["key"]}
    body = {"guid": guid, "indexerId": indexer_id}
    if override:   # a release Whisparr could not match itself: tell it which scene it is for
        body["movieId"] = int(st["movieId"])

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
    # Remembered so "maintain" can finish the import if Whisparr holds it back (picked by hand, or the same
    # resolution as your file). Only downloads picked here are ever imported that way.
    picks = [p for p in _load(PICKS, []) if p.get("movieId") != int(st["movieId"])]
    _save(PICKS, picks + [{"movieId": int(st["movieId"]), "sceneId": str(scene_id), "t": time.time()}])
    set_tags(stash, scene, {cfg["upgrade"].lower()}, tag_id(stash, cfg["pending"]))
    note_request(scene_id)
    log.info(f"[Upgrade] Sent the chosen release for '{scene['title']}' to the download client")
    return {"ok": True}


# Import holds that are fine to override for a release you picked yourself.
_OK_HOLD = re.compile(r"by ID|Manual Import required|not an upgrade|upgrade|cutoff|quality", re.I)


def finish_imports(cfg):
    """Import finished downloads you picked from the ⬆ list that Whisparr holds back ("matched to movie by ID ...
    Manual Import required", or "not an upgrade" for a same-resolution, higher-bitrate file). Only the one
    file that is this scene is imported - for a pack, only a clear match; anything unclear stays for you to
    Manual Import in Whisparr."""
    picks = [p for p in _load(PICKS, []) if time.time() - p.get("t", 0) < PICK_DAYS * 86400]
    mine = {p["movieId"] for p in picks}
    imported, skipped = [], []
    if mine:
        queue = whisparr(cfg, "GET", "/api/v3/queue?pageSize=200") or {}
        for it in queue.get("records") or []:
            if it.get("movieId") not in mine or it.get("trackedDownloadState") not in ("importBlocked", "importFailed"):
                continue
            msgs = " ".join(m for s in (it.get("statusMessages") or []) for m in (s.get("messages") or []))
            if not _OK_HOLD.search(msgs):
                skipped.append(it.get("title"))
                continue
            files = whisparr(cfg, "GET", f"/api/v3/manualimport?downloadId={it['downloadId']}&movieId={it['movieId']}"
                                         "&filterExistingFiles=false") or []
            videos = [f for f in files if (f.get("size") or 0) > 50e6]
            f = None
            if len(videos) == 1:
                f = videos[0]
            elif len(videos) > 1:   # a pack: only the file that clearly is this scene
                try:
                    hint = scene_hint(whisparr(cfg, "GET", f"/api/v3/movie/{it['movieId']}") or {})
                    sc = sorted(((likeness(hint, v.get("relativePath") or v.get("name") or ""), i)
                                 for i, v in enumerate(videos)), reverse=True)
                    if sc[0][0] >= LIKELY and sc[0][0] >= sc[1][0] + 2:
                        f = videos[sc[0][1]]
                except Exception:
                    f = None
            bad = [r.get("reason", "") for r in (f or {}).get("rejections") or [] if not _OK_HOLD.search(r.get("reason", ""))]
            if not f or bad:
                skipped.append(it.get("title"))
                mine.discard(it["movieId"])   # left for a Manual Import - don't keep trying
                continue
            whisparr(cfg, "POST", "/api/v3/command", {"name": "ManualImport", "importMode": "auto", "files": [{
                "path": f["path"], "folderName": f.get("folderName"), "movieId": it["movieId"], "quality": f.get("quality"),
                "languages": f.get("languages") or [], "releaseGroup": f.get("releaseGroup"),
                "downloadId": it["downloadId"], "indexerFlags": f.get("indexerFlags") or 0}]})
            imported.append(it.get("title"))
            mine.discard(it["movieId"])
    _save(PICKS, [p for p in picks if p["movieId"] in mine])
    for t in imported:
        log.info(f"[Upgrade] Imported '{t}' into Whisparr (you picked it, so Whisparr needed a Manual Import)")
    for t in skipped:
        log.warning(f"[Upgrade] '{t}' needs a Manual Import in Whisparr (Activity → Queue) - not clear which file is the scene")
    return {"imported": imported, "skipped": skipped}


def expire_requests(stash, cfg):
    """Give up on upgrade requests older than PENDING_DAYS: drop the pending tag and stop monitoring."""
    req = _load(REQUESTS, {})
    pending = stash.find_scenes({"tags": {"value": [tag_id(stash, cfg["pending"])], "modifier": "INCLUDES"}},
                                fragment=FRAG) or []
    now, keep, gave_up = time.time(), {}, []
    for s in pending:
        t = req.get(str(s["id"]))
        if t is None:   # requested before 2.9.0: start counting now
            t = now
        if cfg["pending_days"] and now - t > cfg["pending_days"] * 86400:
            set_tags(stash, s, {cfg["pending"].lower()})
            sid = stashdb_id(s)
            if sid and not cfg["keep_monitoring"]:
                try:
                    ids = [m["id"] for m in whisparr_movies(cfg, sid)]
                    if ids:
                        whisparr(cfg, "PUT", "/api/v3/movie/editor", {"movieIds": ids, "monitored": False})
                except Exception as e:
                    log.warning(f"[Upgrade] Couldn't stop monitoring '{s['title']}' in Whisparr: {e}")
            gave_up.append(s["title"])
            log.info(f"[Upgrade] No better version of '{s['title']}' in {cfg['pending_days']} days - gave up "
                     f"(removed '{cfg['pending']}'" + ("" if cfg["keep_monitoring"] else ", stopped monitoring") + ")")
        else:
            keep[str(s["id"])] = t
    _save(REQUESTS, keep)
    return gave_up


def maintain(stash, cfg):
    """Housekeeping the buttons ask for every few minutes. Runs at most once per 4 minutes, one at a time."""
    lock = open(os.path.join(HERE, ".maintain.lock"), "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return {"busy": True}
    lock.seek(0)
    try:
        last = float(lock.read().strip() or 0)
    except ValueError:
        last = 0
    if time.time() - last < 240:
        return {"recent": True}
    lock.seek(0)
    lock.truncate()
    lock.write(str(time.time()))
    lock.flush()
    out = {"imported": [], "skipped": [], "gaveUp": []}
    if cfg["auto_import"]:
        out.update(finish_imports(cfg))
    out["gaveUp"] = expire_requests(stash, cfg)
    return out


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
        "auto_import": not raw.get("NO_AUTO_IMPORT"),
        "pending_days": max(0, int(raw.get("PENDING_DAYS") or 0)),
    }
    if not hook.get("id"):
        mode = args.get("mode")
        if mode in ("status", "check", "grab", "maintain"):
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
                    done(grab_release(stash, cfg, args.get("id"), args.get("guid"), args.get("indexerId"),
                                      bool(args.get("override"))))
                if mode == "maintain":
                    done(maintain(stash, cfg))
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
