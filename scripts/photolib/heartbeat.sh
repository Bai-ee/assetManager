#!/bin/zsh
# Posts the life.status/1 heartbeat (see heartbeat.mts). Run by launchd every 300 s; safe to run by hand.
# Settings: ~/.photolib/env (optional LIFE_STATUS_URL), token from HITLOOP_ARCHIVE_WORKER_TOKEN in the repo .env.local.
[ -f $HOME/.photolib/env ] && source $HOME/.photolib/env
NODE_DIR=$(ls -d $HOME/.nvm/versions/node/v24* 2>/dev/null | sort -V | tail -1)
[ -n "$NODE_DIR" ] && export PATH=$NODE_DIR/bin:$PATH
export PATH=/usr/sbin:/usr/bin:/bin:/sbin:/usr/local/bin:/opt/local/bin:$PATH
cd ${0:A:h:h:h} || exit 0
exec npx tsx scripts/photolib/heartbeat.mts "$@"
