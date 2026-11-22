#!/usr/bin/env bash
set -euo pipefail
mkdir -p /vercel/editmind-model
cd /vercel/editmind-model
if [[ ! -x runtime/llama-server ]]; then
  curl -fsSL --retry 3 https://github.com/ggml-org/llama.cpp/releases/download/b12633/llama-b12633-bin-ubuntu-x64.tar.gz -o runtime.tar.gz
  echo '9c4a2c1bd1437f22831e0b56cc75329b321bac87225ffb5c83cd8d13b1f44fa2  runtime.tar.gz' | sha256sum -c -
  mkdir -p runtime
  tar -xzf runtime.tar.gz -C runtime --strip-components=1
fi
if [[ ! -f model.gguf ]]; then
  curl -fsSL --retry 3 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf?download=true' -o model.part
  echo '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597  model.part' | sha256sum -c -
  mv model.part model.gguf
fi
export LD_LIBRARY_PATH="$PWD/runtime${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if ldd ./runtime/llama-server | grep 'not found' >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libgomp1 libcurl4
fi
exec ./runtime/llama-server -m model.gguf --host 127.0.0.1 --port 8090 -c 32768 -t 4 -np 1 --no-warmup
