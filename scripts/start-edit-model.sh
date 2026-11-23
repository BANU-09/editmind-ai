#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$EDITMIND_MODEL_DIR"
cd "$EDITMIND_MODEL_DIR"
# Either tier may start first on a fresh worker.
(
  flock 8
if [[ ! -x runtime/llama-server ]]; then
  curl -fsSL --retry 3 https://github.com/ggml-org/llama.cpp/releases/download/b12633/llama-b12633-bin-ubuntu-x64.tar.gz -o runtime.tar.gz
  echo '9c4a2c1bd1437f22831e0b56cc75329b321bac87225ffb5c83cd8d13b1f44fa2  runtime.tar.gz' | sha256sum -c -
  mkdir -p runtime
  tar -xzf runtime.tar.gz -C runtime --strip-components=1
fi
) 8>/tmp/editmind-llama-install.lock
file="${EDITMIND_MODEL_FILE:?missing model file}"
url="${EDITMIND_MODEL_URL:?missing model URL}"
checksum="${EDITMIND_MODEL_SHA:?missing model checksum}"
port="${EDITMIND_MODEL_PORT:?missing model port}"
context="${EDITMIND_MODEL_CONTEXT:?missing model context}"
if [[ ! -f "$file" ]]; then
  curl -fsSL --retry 3 "$url?download=true" -o "$file.part"
  echo "$checksum  $file.part" | sha256sum -c -
  mv "$file.part" "$file"
fi
export LD_LIBRARY_PATH="$PWD/runtime${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if ldd ./runtime/llama-server | grep 'not found' >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libgomp1 libcurl4
fi
exec ./runtime/llama-server -m "$file" --host 127.0.0.1 --port "$port" -c "$context" -t "$EDITMIND_MODEL_THREADS" -np 1 --no-warmup
