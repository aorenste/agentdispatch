#!/bin/bash
set -ex

cargo build --release
# fwdproxy-config deliberately emits separate KEY=value arguments for env.
# shellcheck disable=SC2046
env $(fwdproxy-config curl --format sh) \
    podman run --rm --network=host --retry=0 --http-proxy=true \
    -v "$PWD:/home/rust/src" \
    -w /home/rust/src \
    -e CARGO_TARGET_DIR=target/arm64 \
    -e CARGO_NET_RETRY=0 \
    docker.io/messense/rust-musl-cross:aarch64-musl \
    cargo build --release

cp target/release/agentdispatch ~/bin/agentdispatch.x86_64
cp target/arm64/aarch64-unknown-linux-musl/release/agentdispatch \
    ~/bin/agentdispatch.aarch64

cat > ~/bin/agentdispatch <<'EOF'
#!/bin/sh
case "$(uname -m)" in
    x86_64) exec "$HOME/bin/agentdispatch.x86_64" "$@" ;;
    aarch64|arm64) exec "$HOME/bin/agentdispatch.aarch64" "$@" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 126 ;;
esac
EOF
chmod +x ~/bin/agentdispatch
