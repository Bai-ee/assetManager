#!/bin/zsh
# icloud-year.sh <fromYear> <toYearExclusive> [--no-download]
# One iCloud batch, one NAS job at a time: download → plan (camera-only) → apply --mode move (full metadata,
# verified raw-dup delete) → thumbs → push → verify. Remounts the NAS and retries when the share drops.
#
# Settings come from ~/.photolib/env (private, never committed; see docs/photolib/SERVER-HANDOFF.md):
#   PHOTOLIB_APPLE_ID          iCloud username icloudpd signed in with (owner signs in; agent never types password/2FA)
#   PHOTOLIB_NAS_SMB           smb://… URL of the share that mounts at /Volumes/bryan
#   PHOTOLIB_PHOTOS_DB         Photos.sqlite used for the per-asset library record (local snapshot path)
#   HITLOOP_ARCHIVE_CONTROL_URL  local HITLOOP dev server (http://localhost:3005); never production
# Env REUSE_PLAN=<planId> skips planning and applies an existing plan for the first month that is not done yet.
#
# MONTHLY CHUNKS: every year runs as month windows YYYY-01..YYYY-12 (+ a year-end sweep). Per month:
#   download (icloudpd --skip-created-before/after the month) → plan (only that month's folder, via --files) → apply →
#   thumbs → push → verify. Log lines: `=== month YYYY-MM ===` … `done YYYY-MM`. A month whose `done YYYY-MM` line is in
#   the year log is skipped on rerun, so a rerun resumes at the first unfinished month. Any failed step fails the year.
#   The sweep (`YYYY-sweep`) plans the whole year folder once to catch files icloudpd filed under a neighbouring month
#   directory (UTC vs local day at a month edge); it is a cheap no-op when nothing new turns up.
# Env DOWNLOAD_SCOPE=year downloads the whole year once up front (icloudpd re-scans the entire library for every
#   window, ~8 min each) and the month loop then only plans/applies/pushes; default is month.
# Test hooks (defaults are the real paths): PHOTOLIB_ICLOUD_ROOT, PHOTOLIB_NAS_MOUNT.
set -u
[ -f $HOME/.photolib/env ] && source $HOME/.photolib/env
FROM=$1; TO=$2; NODL=${3:-}
: ${PHOTOLIB_APPLE_ID:?set in ~/.photolib/env} ${PHOTOLIB_NAS_SMB:?set in ~/.photolib/env} ${PHOTOLIB_PHOTOS_DB:?set in ~/.photolib/env}
CONTROL_URL=${HITLOOP_ARCHIVE_CONTROL_URL:-http://localhost:3005}
NAS=${PHOTOLIB_NAS_MOUNT:-/Volumes/bryan}
ROOT=${PHOTOLIB_ICLOUD_ROOT:-$NAS/iCloud-Photos}
REPO=${PHOTOLIB_REPO:-${0:A:h:h:h}}
LOG=$HOME/.photolib/logs/icloud-run-$FROM-$TO.log
mkdir -p $HOME/.photolib/logs
log() { print -r -- "$(date '+%F %T') $*" | tee -a $LOG; }
mounted() { mount | grep -q " on $NAS " && [ -d $NAS/HITLOOP-ARCHIVE/timeline ]; }
remount() {
  for i in 1 2 3 4 5; do
    mounted && return 0
    log "NAS not mounted, remount attempt $i"
    osascript -e "mount volume \"$PHOTOLIB_NAS_SMB\"" >/dev/null 2>&1; sleep 20
  done
  mounted
}
retry() { # retry <label> <cmd...>
  local label=$1; shift
  for i in 1 2 3; do
    remount || { log "FAIL $label: NAS unavailable"; return 1; }
    "$@" >> $LOG 2>&1 && { log "ok $label"; return 0; }
    log "retry $label ($i)"; sleep ${PHOTOLIB_RETRY_SLEEP:-60}
  done
  log "FAIL $label"; return 1
}

log "=== batch $FROM..$((TO-1)) ==="
[ -f "$PHOTOLIB_PHOTOS_DB" ] || { log "FAIL: PHOTOLIB_PHOTOS_DB not found: $PHOTOLIB_PHOTOS_DB"; exit 1; }
curl -s -o /dev/null -m 10 "$CONTROL_URL/" || { log "FAIL: HITLOOP dev server not reachable at $CONTROL_URL"; exit 1; }
cd $REPO || exit 1

download() { # download <from YYYY-MM-DD> <toExclusive YYYY-MM-DD>
  retry download caffeinate -is icloudpd --username $PHOTOLIB_APPLE_ID --directory $ROOT \
    --folder-structure '{:%Y/%m}' --size original --live-photo-size original --live-photo-mov-filename-policy original \
    --xmp-sidecar --skip-created-before $1 --skip-created-after $2 --no-progress-bar
}

# process <label> <dir to list (month or year folder)> <download from> <download to or "">
process() {
  local label=$1 dir=$2 dlfrom=$3 dlto=$4
  if [ "$NODL" != "--no-download" ] && [ -n "$dlto" ]; then download $dlfrom $dlto || return 1; fi
  [ -d "$dir" ] && log "downloaded $label: $(find $dir -type f ! -name '._*' ! -name '*.xmp' | wc -l | tr -d ' ') files, $(du -sh $dir | cut -f1)"
  remount || return 1
  local PLAN_ID
  if [ -n "${REUSE_PLAN:-}" ]; then PLAN_ID=$REUSE_PLAN; REUSE_PLAN=; log "reusing plan $PLAN_ID"; else
    mkdir -p $HOME/.photolib/lists
    local LIST=$HOME/.photolib/lists/files-$label.txt
    if [ -d "$dir" ]; then find $dir -type f ! -name '._*' ! -name '*.xmp' ! -name '.DS_Store' | sort > $LIST; else : > $LIST; fi
    if [ ! -s $LIST ]; then log "no files in $label, nothing to plan"; return 0; fi
    local PLAN_OUT
    PLAN_OUT=$(PHOTOLIB_CAMERA_ONLY=1 npm run -s photolib -- plan --folder $ROOT --files $LIST --dest-root $NAS --source-id folder-icloud-photos 2>>$LOG | grep -E '^planId')
    log "plan: $PLAN_OUT"
    PLAN_ID=$(print -r -- "$PLAN_OUT" | awk '{print $2}')
    [ -n "$PLAN_ID" ] || { log "FAIL plan"; return 1; }
    if grep -q '"hash failed: ENOTCONN' $HOME/.photolib/plans/$PLAN_ID.json 2>/dev/null; then log "FAIL plan: NAS dropped during hashing; re-run"; return 1; fi
    # Nothing to apply (all leftovers are non-camera): skip apply/thumbs/push for this window.
    if print -r -- "$PLAN_OUT" | grep -q '"items":0,'; then log "plan empty for $label, nothing to apply"; return 0; fi
  fi
  retry apply npm run -s photolib -- apply --plan $PLAN_ID --mode move --photos-db "$PHOTOLIB_PHOTOS_DB" || return 1
  grep '^apply ' $LOG | tail -1 | cut -c1-400 | sed 's/"errors":\[.*\]/"errors":[…]/' | while read -r l; do log "$l"; done
  retry thumbs npm run -s photolib -- thumbs || return 1
  retry push env HITLOOP_ARCHIVE_CONTROL_URL=$CONTROL_URL npm run -s photolib -- push --folder $ROOT --source-id folder-icloud-photos || return 1
  log "verify: $(node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.photolib/photolib.sqlite',{readonly:true});console.log(JSON.stringify(db.prepare(\"select count(*) assets, sum(pushed_at is null) unpushed, sum(thumb_s is null or thumb_m is null) noThumb from assets\").get()))")"
}

is_done() { grep -q " done $1\$" $LOG 2>/dev/null; }
NOW_YM=$(date '+%Y-%m')
for y in $(seq $FROM $((TO-1))); do
  if [ "${DOWNLOAD_SCOPE:-month}" = "year" ] && [ "$NODL" != "--no-download" ]; then
    is_done $y-12 && is_done $y-sweep || download $y-01-01 $((y+1))-01-01 || exit 1
  fi
  for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
    label=$y-$m
    is_done $label && continue
    [[ "$label" > "$NOW_YM" ]] && continue   # future month: nothing to ingest yet
    nm=$((10#$m + 1)); ny=$y; [ $nm -eq 13 ] && { nm=1; ny=$((y+1)); }
    log "=== month $label ==="
    if [ "${DOWNLOAD_SCOPE:-month}" = "year" ]; then DLTO=""; else DLTO=$ny-$(printf %02d $nm)-01; fi
    process $label $ROOT/$y/$m $label-01 "$DLTO" || exit 1
    log "done $label"
  done
  if ! is_done $y-sweep; then
    log "=== month $y-sweep ==="
    process $y-sweep $ROOT/$y "" "" || exit 1
    log "done $y-sweep"
  fi
done
log "=== done $FROM..$((TO-1)) ==="
