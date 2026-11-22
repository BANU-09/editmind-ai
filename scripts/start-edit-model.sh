#!/usr/bin/env bash
set -euo pipefail
mkdir -p /vercel/editmind-model
cd /vercel/editmind-model
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
case "${EDITMIND_MODEL_TIER:-planner}" in
  fast)
    file=router-qwen2.5-1.5b.gguf
    url='https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf'
    checksum=6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e
    port=8091
    context=8192
    ;;
  planner)
    file=model.gguf
    url='https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
    checksum=3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597
    port=8090
    context=32768
    ;;
  *) exit 64 ;;
esac
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
exec ./runtime/llama-server -m "$file" --host 127.0.0.1 --port "$port" -c "$context" -t 4 -np 1 --no-warmup
