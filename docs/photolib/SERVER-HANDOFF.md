# Life Timeline photo ingest: always-on server handoff

**Audience:** an agent on a brand-new machine that has never run anything. Read this whole file, then do the steps in
order. Do not skip the verify steps. Stop and ask the owner whenever a step says so.

**Goal of the project:** every personal photo and video ends up on the private Life Timeline, oldest to newest, with no
duplicates and ALL metadata captured. Originals live on the owner's NAS under `HITLOOP-ARCHIVE/timeline/YYYY/MM/`; the
index goes to the owner's personal Firestore (`life_media`, `life_months`, `life_sources`) through a LOCAL HITLOOP dev
server; JPEG thumbs go to private Storage `life-thumbs/`.

**Your job on arrival:** set the machine up (steps 1–8), then continue the iCloud ingest from year **2020** through
**2026** (step 9), reporting progress to the owner every 5 minutes.

## State at handoff (2026-11-08, 23:20 local)

- Timeline: **11,128 assets**, 0 unpushed, 0 missing thumbs.
- Done: the whole NAS share (old Photos/iPhoto libraries + loose folders), one attached drive, iCloud years 2015–2019.
- Next: iCloud 2020, 2021, 2022, 2023, 2024, 2025, 2026 (about 81k iCloud items; roughly 4–5 days of running).
- Nothing is mid-flight. The 2020 download was stopped before it wrote any file.
- The **private** half of this handoff (account name, NAS address, owner decisions, exclusions, drive to-dos) is on the
  NAS at `HITLOOP-ARCHIVE/_photolib-state/PRIVATE-HANDOFF.md`. This repo is public: never copy that file's contents,
  the manifest, logs, plan JSON, or any `.env*` into git.

## Hard rules (owner decisions; never break)

1. **Metadata first.** Every file's full exiftool dump, its `.xmp` sidecar(s), and its Photos library record are saved
   to `timeline/_meta/<sha[0:2]>/` BEFORE it is moved or any raw duplicate is deleted. The code enforces this
   (`apply --mode move` refuses to run without capture). Never bypass it.
2. **Never delete from iCloud.** Never pass `--auto-delete`, `--delete-after-download`, or `--set-exif-datetime` to
   icloudpd.
3. Raw duplicates are deleted only after a verified full-resolution original with the same sha256 is on the timeline
   (the code re-hashes both copies first).
4. Non-camera items (screenshots, saved images, no camera date) stay in `bryan/iCloud-Photos/<YYYY>/<MM>` as the raw
   backup. Do not move them anywhere else.
5. **Apple ID password and 2FA are typed by the owner only.** Never ask the owner to paste them into chat; if they do,
   tell them to change the password and never repeat it.
6. **One NAS write job at a time.** The WD NAS drops the SMB share under parallel load (ENOTCONN). Never run two
   photolib commands, a big copy, or an `ls` of a huge NAS folder alongside a running batch.
7. The photolib ingest pushes its index to the LOCAL dev server (`HITLOOP_ARCHIVE_CONTROL_URL=http://localhost:3005`).
   The HITLOOP harness on this machine runs with the owner's full `.env.local` and full privileges: all of its
   functions and integrations (paid APIs included) are meant to be active here.
8. Personal scope only: never touch `x_content_packages`, `timeline_entries`, buckets, the Brain, or the content agent.
9. Never write inside a photo library bundle (`*.photoslibrary`, `iPhoto Library`). Never delete single files inside one.
10. Skip the libraries and folders the private handoff lists as excluded (another person's material).
11. Commit per phase on the feature branches; push only when the owner asks.

## 1. Machine requirements

- **macOS** (required: thumbnails use `sips` for HEIC/RAW, the NAS remount uses `osascript`). Tested on macOS 15.6.
- Same LAN as the NAS. Enough local disk for thumbnails: ~0.23 MB per item, so ~20 GB more for 2020–2026, plus ~6 GB
  for a temp copy of the Photos DB during each apply, plus ~10 GB headroom.
- Disable sleep for the duration: `sudo pmset -a sleep 0 disksleep 0` (ask the owner first; they type the sudo
  password). The scripts also wrap downloads in `caffeinate`.

## 2. Toolchain (versions known to work)

```sh
xcode-select --install                       # git, clang (owner may need to click through)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@24 ffmpeg icloudpd gh     # node 24.7, npm 11.5, ffmpeg 8.0.1, icloudpd 1.33.0
gh auth login                                # owner completes the browser login
```

`exiftool` comes from npm (`exiftool-vendored`, needs the system `perl`, which macOS ships). `better-sqlite3` builds a
native module during `npm ci` (needs the Xcode command line tools).

## 3. Clone both repos

```sh
mkdir -p ~/Documents/Repos && cd ~/Documents/Repos
git clone https://github.com/Bai-ee/assetManager.git assetManager-photolib
cd assetManager-photolib && git checkout feat/photolib && npm ci && cd ..
git clone https://github.com/Bai-ee/port_2026.git Bballi_Portfolio-life-timeline
cd Bballi_Portfolio-life-timeline && git checkout feat/life-timeline && npm ci && cd ..
```

- `assetManager` `feat/photolib` = the worker: `npm run photolib -- plan|apply|undo|thumbs|push|status`, code in
  `lib/photolib/`, run scripts in `scripts/photolib/`, design doc `docs/archive/PHOTOLIB.md`.
- `port_2026` `feat/life-timeline` = HITLOOP side: owner-only API + `/dashboard/life` page + worker ingest routes
  (`app/api/archive/worker/life/*`, `features/life-timeline/`). SSOT `docs/source-of-truth/LIFE-TIMELINE.md`.

Verify: `cd assetManager-photolib && npx tsx --test lib/photolib/*.test.ts` → **109 pass, 0 fail**.

## 4. Secrets (owner supplies; never from git or the NAS)

Ask the owner to copy these two files over a private channel (AirDrop, password manager). Names only here:

- `assetManager-photolib/.env.local`: `HITLOOP_ARCHIVE_CONTROL_URL`, `HITLOOP_ARCHIVE_WORKER_TOKEN`,
  `HITLOOP_ARCHIVE_WORKER_ID` (the other keys in that file are for unrelated pipelines and can be left out).
- `Bballi_Portfolio-life-timeline/.env.local`: the owner's **full** HITLOOP env file, unchanged; do not trim it.
  The life timeline needs at least `NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_ADMIN_PROJECT_ID`,
  `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`, `FIREBASE_ADMIN_STORAGE_BUCKET`,
  `HITLOOP_ARCHIVE_WORKER_TOKEN` (same value as the worker's), and `LIFE_OWNER_UIDS`. Every other key stays so the
  rest of the HITLOOP harness works on this machine.

`chmod 600` both files.

## 5. Mount the NAS

The owner gives you the SMB URL (it is also in `~/.photolib/env` after step 6, but you need the mount first):

```sh
osascript -e 'mount volume "smb://GUEST:@<nas-ip>/bryan"'    # mounts at /Volumes/bryan
ls /Volumes/bryan/HITLOOP-ARCHIVE/_photolib-state
```

Expect: `photolib.sqlite`, `Photos.sqlite`, `plans-logs.tar`, `thumbs.tar`, `PRIVATE-HANDOFF.md`, plus copies of the
two owner plan docs. If the mount drops later, the scripts remount on their own.

## 6. Restore the working state

```sh
S=/Volumes/bryan/HITLOOP-ARCHIVE/_photolib-state
mkdir -p ~/.photolib
cp $S/photolib.sqlite ~/.photolib/photolib.sqlite     # the manifest: every asset, location, run, journal row
cp $S/Photos.sqlite  ~/.photolib/Photos.sqlite        # snapshot of the owner's Photos DB (library records)
tar -C ~/.photolib -xf $S/plans-logs.tar              # plans/, logs/, env (private settings)
tar -C ~/.photolib -xf $S/thumbs.tar                  # thumbs/ cache (~18.7k JPEGs)
chmod 600 ~/.photolib/env
cat $S/PRIVATE-HANDOFF.md                             # read it fully before continuing
```

Copy single files, never thousands of small files, over SMB (small-file copies to this NAS run at ~25 files/min).

**Thumb paths are absolute.** The manifest stores `thumb_s`/`thumb_m` as `/Users/bballi/.photolib/thumbs/…`. If this
machine's home folder differs, rewrite them once:

```sh
cd ~/Documents/Repos/assetManager-photolib
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.photolib/photolib.sqlite');const r=db.prepare(\"update assets set thumb_s=replace(thumb_s,'/Users/bballi/',?), thumb_m=replace(thumb_m,'/Users/bballi/',?)\").run(process.env.HOME+'/',process.env.HOME+'/');console.log(r.changes)"
```

`~/.photolib/env` sets `PHOTOLIB_PHOTOS_DB=$HOME/.photolib/Photos.sqlite`; keep that (the server has no Photos app
library of its own).

Verify:

```sh
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.photolib/photolib.sqlite',{readonly:true});console.log(db.prepare(\"select count(*) assets, sum(pushed_at is null) unpushed, sum(thumb_s is null or thumb_m is null) noThumb from assets\").get())"
```

Expect `{ assets: 11128, unpushed: 0, noThumb: 0 }`.

## 7. Start the local HITLOOP dev server (must stay up during every batch)

```sh
cd ~/Documents/Repos/Bballi_Portfolio-life-timeline
nohup npx next dev --webpack -p 3005 > ~/.photolib/logs/life-dev-3005.log 2>&1 &
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3005/      # expect 200 (first compile takes a minute)
```

Do NOT run `npm run build` in that checkout while the dev server runs.

## 8. iCloud sign-in (owner does this)

```sh
source ~/.photolib/env
icloudpd --username "$PHOTOLIB_APPLE_ID" --auth-only
```

Hand the terminal to the owner (in Claude Code: ask them to type `! icloudpd --username … --auth-only`). They type the
password and the 2FA code. The session lands in `~/.pyicloud`. If a batch later fails at "download" with an auth
error, the session expired: stop and ask the owner to repeat this step.

## 9. Run the rest of the project

```sh
cd ~/Documents/Repos/assetManager-photolib
nohup zsh scripts/photolib/icloud-all.sh 2020 > ~/.photolib/logs/icloud-all.nohup 2>&1 &
```

Each year runs `scripts/photolib/icloud-year.sh <y> <y+1>` (the interface `icloud-all.sh` calls; unchanged). Since
the monthly-chunk change (branch `feat/photolib-monthly`) the year is processed as month windows, oldest first. Per month:
download (icloudpd with `--skip-created-before YYYY-MM-01 --skip-created-after <next month>-01`, originals + Live Photo
videos + XMP sidecars into `bryan/iCloud-Photos/YYYY/MM`) → plan (camera-only, source id `folder-icloud-photos`, only
that month's folder through `--files`, so `relativePath` stays relative to the iCloud-Photos root) → apply
`--mode move --photos-db` (metadata capture, verified move, verified raw-dup delete) → thumbs → push → verify. Every
month is pushed before the next starts, so the timeline fills in month by month. After December a `YYYY-sweep` window
plans the whole year folder once (catches a file icloudpd filed under a neighbouring month directory at a month edge;
a no-op when nothing new). The run stops at the first failed step so nothing runs out of order. The batch that was
already running when this landed (2020) finishes the old way (one whole-year pass); monthly starts with the next year
after the checkout is fast-forwarded.

Month log lines in `icloud-run-<y>-<y+1>.log`: `=== month YYYY-MM ===` opens a month, then the usual step lines
(`ok download`, `plan: planId …`, `ok apply`, `apply {…}`, `ok thumbs`, `ok push`, `verify: {…}`), then `done YYYY-MM`.
Empty months log `no files in YYYY-MM, nothing to plan`.

Download scope. Every icloudpd window walks the whole library newest-first (75,771 items, about 31 min of pure
skipping per window), so one window per month would cost about 40 h over the project. The download is therefore
batched: scope `quarter` (default) downloads `[this month, next quarter start)`, `month` downloads `[this month, next month)`,
`year` downloads `[this month, next January)`. Each month iteration downloads only when the year log has no
`downloaded-window A..B` line covering it (written after a successful download; an old-style `downloaded YYYY-MM:` line
covers that one month), so the rest of the window just runs plan/apply/thumbs/push (`download scope quarter: none (covered…)`).
A restart anywhere resumes correctly because coverage comes from the log. The scope is re-read at the start of every month
from `~/.photolib/DOWNLOAD_SCOPE` (one word: `month`, `quarter` or `year`), else env `DOWNLOAD_SCOPE`, else `quarter`, so
the owner can change it mid-run: `echo month > ~/.photolib/DOWNLOAD_SCOPE`. The first real monthly cycle (2020-01) ran end to
end under the month-per-window script.

Report every 5 minutes (a `sleep 300` background timer, then read the logs):

- `~/.photolib/logs/icloud-all.log` (batch start/finish/STOPPED)
- `~/.photolib/logs/icloud-run-<y>-<y+1>.log` (step lines start with a date; progress lines are `n/total`)
- free disk: `df -h /`
- `~/.photolib/status.json`, written every 5 minutes by the heartbeat (below); `jq . ~/.photolib/status.json`

### Heartbeat and status.json

`scripts/photolib/heartbeat.sh` (runs `heartbeat.mts`) builds the public `life.status/1` document from RUN_ENABLED,
`icloud-all.log`, the newest `icloud-run-*.log`, the manifest (readonly), `pmset`, `df`, `mount`, port 3005 and `pgrep`,
writes it to `~/.photolib/status.json` and POSTs it to `${LIFE_STATUS_URL:-https://life.hitloop.agency}/api/archive/worker/life/status`
(bearer `HITLOOP_ARCHIVE_WORKER_TOKEN` from the repo `.env.local`). It never touches the NAS beyond `mount`, and the
document holds no paths, file names or account names. A failed POST is one line in `~/.photolib/logs/heartbeat.log`;
status.json is still written. launchd agent `com.bballi.photolib.heartbeat` (plist in `~/server/launchd`, every 300 s):

```sh
launchctl bootstrap gui/$(id -u) ~/server/launchd/com.bballi.photolib.heartbeat.plist
launchctl print gui/$(id -u)/com.bballi.photolib.heartbeat | head   # check
zsh ~/Documents/Repos/assetManager-photolib/scripts/photolib/heartbeat.sh   # run once by hand
```

Reading status.json: `run.state` running/stopped/done/idle (idle = no `icloud-all.sh` process), `run.batch` the year or
month (`2021-03`), `run.step` download/plan/apply/thumbs/push/verify with `stepStartedAt`, `run.error` a short reason when
stopped. `progress.batchesDone/Total/Remaining` count years until monthly mode shows up in the logs, months after.
`itemsPerMin` is the manifest `assets` growth over the last 3 h (null under 10 min of history or no growth);
`etaFinishAt` is the average wall time of the finished batches of this run times the batches left (null until one
batch has finished). `_samples` is a private array for the rate and is not posted.

Approximate rates on the old Mac: plan hashing ~140 items/min, apply ~30–140 items/min, thumbs ~70 items/min.

### When something goes wrong

| Symptom | Do |
|---|---|
| `STOPPED at <y>` in icloud-all.log | Read the year log's last lines (`=== month YYYY-MM ===` says which month failed; `status.json` shows `run.stoppedAt` and `run.error`). Fix the cause, then `zsh scripts/photolib/icloud-all.sh <y>`. Download, plan, apply are all idempotent, and months with a `done YYYY-MM` line are skipped, so it resumes at the failed month. |
| Download window does not cover a month you expect (files missing) | Check `grep -E 'downloaded-window|download scope' <year log>`. Delete the covering `downloaded-window` line (or the month's `downloaded YYYY-MM:` line) from the log to force that month to download again, or set `echo month > ~/.photolib/DOWNLOAD_SCOPE`. |
| Resume one month by hand | `zsh scripts/photolib/icloud-year.sh <y> <y+1>` continues at the first month without a `done` line. To force a month again, delete its `done YYYY-MM` line from the year log (or move the log aside; every step is idempotent). |
| status.json stale or the status page says "stale" | Heartbeat agent not running: `launchctl print gui/$(id -u)/com.bballi.photolib.heartbeat`, then `cat ~/server/logs/heartbeat.err.log ~/.photolib/logs/heartbeat.log`. A `POST failed` line only means the page did not get the update; status.json is still fresh. |
| Apply interrupted after a good plan | Resume without re-hashing (applies the plan to the first month that is not done): `REUSE_PLAN=<planId> zsh scripts/photolib/icloud-year.sh <y> <y+1> --no-download`, then `icloud-all.sh <y+1>`. Files already moved show as "File not found" errors in the rerun; that is expected (check the journal: `select count(*) from journal where src_path like 'iCloud-Photos/<y>/%'`). |
| Plan contains `hash failed: ENOTCONN` | The NAS dropped mid-hash. The script refuses to apply it; rerun the year. |
| Process stuck in state `U` with 0% CPU | NAS I/O stall. Check `stat /Volumes/bryan/HITLOOP-ARCHIVE/timeline` speed; wait or remount. Never start a second NAS job "to test". |
| Disk filling up | Each interrupted apply leaves a ~3 GB `photosdb-*` folder in `$TMPDIR`. Delete the ones no process holds open (`lsof +D <dir>` empty). |
| icloudpd auth error | Step 8, owner only. |

### After each year

The last month's `verify: {...}` line (before `=== done <y>..<y> ===`) must show `unpushed: 0, noThumb: 0`. Tell the owner the year's count, how
many raw duplicates were deleted, and how many non-camera items stayed in the raw backup.

## 10. After 2026 is done

- Update `docs/photolib/SERVER-HANDOFF.md` state and the private handoff, commit on `feat/photolib`.
- Ask the owner about the open decisions listed in the private handoff (shared albums, undated scans, attached-drive
  leftovers). Do not act on any of them without an answer.

## Known traps (learned the hard way)

- The WD NAS takes ~1 s per name lookup in a 10k-entry folder. That is why new metadata goes to `_meta/<sha[0:2]>/`
  and XMP folders are listed once per run. Never add a per-file `readdir`/`existsSync` against a big NAS folder.
- Server-side SMB copies and big simultaneous read+write drop the share; the code streams and stages large files
  through local disk (`~/.photolib/stage`).
- icloudpd lists newest first and skips ~2,300 items/min to reach older years, so a 2020 batch spends a while
  "skipping" before downloading. That is normal.
- Shared Album items (~23k) are not downloaded by icloudpd; that is an open owner decision, not a bug.
- `sqlite3 -readonly` from a NAS working directory fails with "unable to open database file"; use node +
  better-sqlite3 from the repo instead.
