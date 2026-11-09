#!/bin/zsh
# icloud-all.sh [startYear] — oldest → newest, one year per batch (2015–2019 were one batch, done 2026-11-08).
# Stops at the first failed batch so nothing runs out of order. Log: ~/.photolib/logs/icloud-all.log
S=${0:A:h}
L=$HOME/.photolib/logs/icloud-all.log
mkdir -p $HOME/.photolib/logs
START=${1:-2020}
print -r -- "$(date '+%F %T') start at $START" >> $L
for y in $(seq $START 2026); do
  zsh $S/icloud-year.sh $y $((y+1)) || { print -r -- "$(date '+%F %T') STOPPED at $y" >> $L; exit 1; }
  print -r -- "$(date '+%F %T') finished $y" >> $L
done
print -r -- "$(date '+%F %T') ALL DONE" >> $L
