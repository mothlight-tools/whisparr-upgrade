# Whisparr Upgrade (Stash plugin)

Ask Whisparr for a better-quality version of any scene with one click. When the upgrade downloads, it is **merged back into your existing scene**, so you keep its markers, rating, play history and tags.

Optional: a one-click **delete** that removes the scene and its file *and* adds it to Whisparr's exclusion list, so it is never downloaded again.

*Built with the help of AI (Claude). I use it daily on my own setup, and I'm happy to fix any bugs you find.*

## What you get

| | |
|---|---|
| **⬆ button** (under the scene title + player control bar) | Adds the `Upgrade` tag → Whisparr monitors the scene and searches for a better release. The tag changes to `Upgrade Requested` and the arrow turns green. |
| **Automatic merge** | When the new file is imported, the plugin merges it into the original scene, removes `Upgrade Requested` and stops monitoring the scene in Whisparr (so it isn't upgraded again, or re-downloaded if you delete it later). Run Stash's **Clean** task afterwards to drop the old file entry. |
| **🗑 button** (off by default) | Asks for confirmation, then deletes the scene + file and excludes it in Whisparr. |
| **Tags work too** | Adding the `Upgrade` or `Delete` tag by hand (or in bulk) does the same thing. |

## Where the buttons are

Open any scene. The ⬆ (and 🗑, if delete is turned on) appear in two places:

- **Under the scene title** - on the line with the release date and quality, between the two (e.g. `April 4, 2023  ⬆ 🗑  29.97 fps | 1080p`).
- **Stash UI** (the alternative front end) - in its player's control bar too (needs a Stash UI version with the `player.controls` extension spot).
- **Video player** - in the control bar along the bottom of the player, just left of the fullscreen button (move the mouse over the video to show it).

Hover a button to see what it does. The ⬆ turns green once an upgrade has been requested. Don't want buttons? Turn on **Hide the ⬆ / 🗑 buttons** and use the tags instead.

## Requirements

- Stash v0.25 or newer
- Whisparr v3 (the StashDB-based version), reachable from your Stash server
- Python with **stashapp-tools**: `pip install stashapp-tools`
- Scenes need a **StashDB** link (identify them with StashDB first)
- For the automatic merge, Whisparr's folder naming must include the StashDB ID in square brackets, e.g. `{Release Date} - {Title} [{StashId}]` (this is how Whisparr v3 names folders by default in most setups)

## Install

1. Stash → **Settings → Plugins → Available Plugins → Add Source**
   - Name: `Whisparr Upgrade`
   - URL: `https://mothlight-tools.github.io/whisparr-upgrade/index.yml`
2. Tick **Whisparr Upgrade** → **Install**, then **Reload plugins** and refresh the page (F5).
3. Open the plugin's settings and fill in:
   - **Whisparr URL**, e.g. `http://localhost:6969`
   - **Whisparr API Key**, from Whisparr → Settings → General
   - Turn on **Enable delete** only if you want the 🗑 button / Delete tag.

## Settings

| Setting | Default | |
|---|---|---|
| Whisparr URL | `http://localhost:6969` | |
| Whisparr API Key | – | required |
| Enable delete | off | shows 🗑 and lets the Delete tag delete files |
| Keep monitoring after an upgrade arrives | off | on = Whisparr keeps watching the scene after the upgrade (more upgrades, re-download if deleted) |
| Hide the ⬆ / 🗑 buttons | off | use tags only |
| Upgrade tag | `Upgrade` | |
| Pending tag | `Upgrade Requested` | |
| Delete tag | `Delete` | |

## How an upgrade works, step by step

1. **You ask for it** - click ⬆ (or add the `Upgrade` tag). The plugin switches the scene to **monitored** in Whisparr and starts a search. The tag becomes `Upgrade Requested`.
2. **Whisparr looks for a better copy** - it only grabs a release your Whisparr quality profile rates higher than the file you have. If nothing better exists yet, the scene stays monitored and `Upgrade Requested`, so Whisparr keeps checking new releases.
3. **The better file arrives** - Whisparr imports it and Stash scans it in as a new scene. The plugin spots it and **merges it into your original scene**: markers, rating, play count and tags stay, and you now have the better file.
4. **Clean-up** - the plugin removes `Upgrade Requested` and **stops monitoring the scene** in Whisparr.

### Why it stops monitoring afterwards

In Whisparr, *monitored* means "keep looking after this scene", not "download it once". A monitored scene that already has a file is still watched:

- **More upgrades** - Whisparr keeps replacing the file whenever an even better release appears, until your quality profile's top quality is reached.
- **Re-downloads** - if the file ever disappears (for example you delete the scene in Stash), Whisparr treats it as missing and downloads it again.

That's useful for a collection you always want to keep at the best quality, but surprising if you only wanted one better copy, or you prune your library by hand. So by default the plugin turns monitoring off once the upgrade is in.

Want Whisparr to keep looking after upgraded scenes instead? Turn on **Keep monitoring after an upgrade arrives** in the plugin settings.

## Notes

- Deleting is permanent. The file is not moved to a trash folder.
- Upgrades use your Whisparr quality profile, so Whisparr only grabs something it considers better than what you have.
- Messages appear in Stash's log (Settings → Logs), prefixed `[Upgrade]` or `[Delete]`.
