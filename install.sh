#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/iseungsang01/solarcido/archive/refs/heads/main.tar.gz"
INSTALL_DIR="${SOLARCIDO_INSTALL_DIR:-$HOME/.solarcido}"
BIN_DIR="${SOLARCIDO_BIN_DIR:-$HOME/.local/bin}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "solarcido install: missing required command: $1" >&2
    exit 1
  fi
}

need cargo
need rustc
need tar

if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ] || [ "$INSTALL_DIR" = "$HOME" ]; then
  echo "solarcido install: unsafe install directory: $INSTALL_DIR" >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_URL" -o "$TMP_DIR/solarcido.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_DIR/solarcido.tar.gz" "$REPO_URL"
else
  echo "solarcido install: missing required command: curl or wget" >&2
  exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
tar -xzf "$TMP_DIR/solarcido.tar.gz" -C "$TMP_DIR"
cp -R "$TMP_DIR"/solarcido-main/. "$INSTALL_DIR"/

cd "$INSTALL_DIR"
HOST_TARGET="$(rustc -vV | awk '/^host:/ { print $2 }')"
cargo build --release -p solarcido-cli --target "$HOST_TARGET"

cat > "$BIN_DIR/solarcido" <<SH
#!/usr/bin/env sh
exec "$INSTALL_DIR/target/$HOST_TARGET/release/solarcido" "\$@"
SH
chmod +x "$BIN_DIR/solarcido"

echo "solarcido installed to $INSTALL_DIR"
echo "Command installed at $BIN_DIR/solarcido"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "Add this to your shell profile if solarcido is not found:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Next:"
echo "  export UPSTAGE_API_KEY=\"your_key\""
echo "  solarcido"
