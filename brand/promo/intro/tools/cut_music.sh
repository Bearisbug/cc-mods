#!/usr/bin/env bash
# 从原曲《栖谷来信》剪出片子的配乐，写到 assets/audio.wav（77 秒，48 kHz）。
# 原曲 0–37.49 秒接 88.87–128.44 秒，交叉淡化 60 毫秒；两刀都下在拍点前，原曲 88.96 秒的拍点落在片内 37.52 秒，
# 原曲的结尾和弦（122.67 秒）落在片内 71.23 秒。接点前后各四拍的和声相似度是 0.72 和 0.82（librosa 节拍同步色度）。
# 末尾 1 秒淡出；原曲真峰值比响度高 14 dB，先限幅 3.5 dB，两遍 loudnorm 才能按线性增益归一到 −14 LUFS。
# 用法：bash tools/cut_music.sh <原曲音频>
set -euo pipefail
src="$1"
dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ffmpeg -v error -y -i "$src" -filter_complex "
  [0:a]atrim=0:37.49,asetpts=N/SR/TB[a];
  [0:a]atrim=88.87:128.44,asetpts=N/SR/TB[b];
  [a][b]acrossfade=d=0.06:c1=qsin:c2=qsin,afade=t=out:st=76:d=1,alimiter=limit=0.668:attack=5:release=50:level=disabled" \
  -ar 48000 -ac 2 "$tmp/cut.wav"
norm="I=-14:TP=-2:LRA=11"
m=$(ffmpeg -hide_banner -nostats -i "$tmp/cut.wav" -af "loudnorm=$norm:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p" <<<"$m" | head -1; }
ffmpeg -v error -y -i "$tmp/cut.wav" -vn -af "loudnorm=$norm:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true" \
  -ar 48000 "$dir/assets/audio.wav"
