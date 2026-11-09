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
# Env REUSE_PLAN=<planId> skips planning and applies an existing plan (resume after an interrupted apply).
set -u
[ -f $HOME/.photolib/env ] && source $HOME/.photolib/env
FROM=$1; TO=$2; NODL=${3:-}
: ${PHOTOLIB_APPLE_ID:?set in ~/.photolib/env} ${PHOTOLIB_NAS_SMB:?set in ~/.photolib/env} ${PHOTOLIB_PHOTOS_DB:?set in ~/.photolib/env}
CONTROL_URL=${HITLOOP_ARCHIVE_CONTROL_URL:-http://localhost:3005}
ROOT=/Volumes/bryan/iCloud-Photos
REPO=${PHOTOLIB_REPO:-${0:A:h:h:h}}
LOG=$HOME/.photolib/logs/icloud-run-$FROM-$TO.log
mkdir -p $HOME/.photolib/logs
log() { print -r -- "$(date '+%F %T') $*" | tee -a $LOG; }
mounted() { mount | grep -q ' on /Volumes/bryan ' && [ -d /Volumes/bryan/HITLOOP-ARCHIVE/timeline ]; }
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
    log "retry $label ($i)"; sleep 60
  done
  log "FAIL $label"; return 1
}

log "=== batch $FROM..$((TO-1)) ==="
[ -f "$PHOTOLIB_PHOTOS_DB" ] || { log "FAIL: PHOTOLIB_PHOTOS_DB not found: $PHOTOLIB_PHOTOS_DB"; exit 1; }
curl -s -o /dev/null -m 10 "$CONTROL_URL/" || { log "FAIL: HITLOOP dev server not reachable at $CONTROL_URL"; exit 1; }
cd $REPO || exit 1
if [ "$NODL" != "--no-download" ]; then
  retry download caffeinate -is icloudpd --username $PHOTOLIB_APPLE_ID --directory $ROOT \
    --folder-structure '{:%Y/%m}' --size original --live-photo-size original --live-photo-mov-filename-policy original \
    --xmp-sidecar --skip-created-before $FROM-01-01 --skip-created-after $TO-01-01 --no-progress-bar || exit 1
fi
for y in $(seq $FROM $((TO-1))); do [ -d $ROOT/$y ] && log "downloaded $y: $(find $ROOT/$y -type f ! -name '._*' ! -name '*.xmp' | wc -l | tr -d ' ') files, $(du -sh $ROOT/$y | cut -f1)"; done

remount || exit 1
if [ -n "${REUSE_PLAN:-}" ]; then PLAN_ID=$REUSE_PLAN; log "reusing plan $PLAN_ID"; else
  PLAN_OUT=$(PHOTOLIB_CAMERA_ONLY=1 npm run -s photolib -- plan --folder $ROOT --dest-root /Volumes/bryan --source-id folder-icloud-photos 2>>$LOG | grep -E '^planId')
  log "plan: $PLAN_OUT"
  PLAN_ID=$(print -r -- "$PLAN_OUT" | awk '{print $2}')
  [ -n "$PLAN_ID" ] || { log "FAIL plan"; exit 1; }
  if grep -q '"hash failed: ENOTCONN' $HOME/.photolib/plans/$PLAN_ID.json 2>/dev/null; then log "FAIL plan: NAS dropped during hashing; re-run"; exit 1; fi
fi

retry apply npm run -s photolib -- apply --plan $PLAN_ID --mode move --photos-db "$PHOTOLIB_PHOTOS_DB" || exit 1
grep '^apply ' $LOG | tail -1 | cut -c1-400 | sed 's/"errors":\[.*\]/"errors":[…]/' | while read -r l; do log "$l"; done
retry thumbs npm run -s photolib -- thumbs || exit 1
retry push env HITLOOP_ARCHIVE_CONTROL_URL=$CONTROL_URL npm run -s photolib -- push --folder $ROOT --source-id folder-icloud-photos || exit 1
log "verify: $(node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.photolib/photolib.sqlite',{readonly:true});console.log(JSON.stringify(db.prepare(\"select count(*) assets, sum(pushed_at is null) unpushed, sum(thumb_s is null or thumb_m is null) noThumb from assets\").get()))")"
log "=== done $FROM..$((TO-1)) ==="
