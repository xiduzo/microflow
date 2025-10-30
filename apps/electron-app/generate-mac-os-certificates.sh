#!/usr/bin/env bash
set -euo pipefail

# Load .env
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo ".env not found in current directory."
  exit 1
fi

# Required env vars
: "${APPLE_IDENTITY:?Set APPLE_IDENTITY in .env, e.g. Developer ID Application: Your Name (TEAMID)}"
: "${APPLE_ID:?Set APPLE_ID in .env (your Apple ID email)}"
: "${MACOS_CERTIFICATE_PWD:?Set MACOS_CERTIFICATE_PWD in .env (export password for .p12)}"

# Optional (for temp keychain if you want to import and verify)
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)}"

CURRENT_DIR=$(pwd)
WORKDIR="${CURRENT_DIR}/.macos_codesign"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "Working in: $(pwd)"

KEY_FILE="developer_id_app.key"
CSR_FILE="developer_id_app.csr"
CER_FILE="developer_id_app.cer"
P7B_FILE="developer_id_app.p7b"
CHAIN_PEM="chain.pem"
P12_FILE="developer_id_app.p12"
B64_FILE="developer_id_app.p12.base64.txt"

# 1) Generate private key and CSR
if [[ ! -f "$KEY_FILE" ]]; then
  echo "Generating private key: $KEY_FILE"
  openssl genrsa -out "$KEY_FILE" 2048
fi

if [[ ! -f "$CSR_FILE" ]]; then
  echo "Generating CSR: $CSR_FILE"
  # Subject CN is not strictly used by Apple; the portal binds CSR to your account
  openssl req -new -key "$KEY_FILE" -out "$CSR_FILE" -subj "/CN=${APPLE_IDENTITY}/emailAddress=${APPLE_ID}"
fi

echo
echo "CSR generated at: $(pwd)/$CSR_FILE"
echo "Next step (manual):"
echo "- Open Apple Developer portal → Certificates → + → Choose 'Developer ID Application' → Upload this CSR."
echo "- Download the issued certificate as .cer (preferred) or .p7b."
echo "- Place it here as '$CER_FILE' or '$P7B_FILE'."
read -r -p "Press Enter after you've placed the certificate file here..."

if [[ -f "$P7B_FILE" && ! -f "$CER_FILE" ]]; then
  echo "Converting $P7B_FILE to PEM chain..."
  openssl pkcs7 -print_certs -in "$P7B_FILE" -out "$CHAIN_PEM"
  # Extract first cert as leaf if needed
  awk 'BEGIN{c=0} /BEGIN CERTIFICATE/{c++; fn=(c==1?"leaf.pem":sprintf("ca_%02d.pem",c-1)); print > fn; in=1; next} /END CERTIFICATE/{print >> fn; close(fn); in=0; next} { if(in) print >> fn }' "$CHAIN_PEM"
  if [[ -f "leaf.pem" ]]; then
    CER_FILE="leaf.pem"
    echo "Using leaf.pem as leaf certificate."
  else
    echo "Could not isolate leaf certificate from $P7B_FILE; please provide a .cer file."
    exit 1
  fi
fi

if [[ ! -f "$CER_FILE" ]]; then
  echo "Missing $CER_FILE. Please place your downloaded Developer ID Application .cer here."
  exit 1
fi

# 2) Create .p12 bundle (leaf cert + private key) — chain is optional for import
echo "Creating PKCS#12: $P12_FILE"
# Use env var for passout to avoid showing in process list
export MACOS_CERTIFICATE_PWD
openssl pkcs12 -export \
  -inkey "$KEY_FILE" \
  -in "$CER_FILE" \
  -name "$APPLE_IDENTITY" \
  -out "$P12_FILE" \
  -passout env:MACOS_CERTIFICATE_PWD

# 3) Base64 encode for GitHub secret
base64 -i "$P12_FILE" > "$B64_FILE"

echo
echo "Created:"
echo "- Private key: $(pwd)/$KEY_FILE"
echo "- Certificate: $(pwd)/$CER_FILE"
echo "- PKCS#12:     $(pwd)/$P12_FILE"
echo "- Base64:      $(pwd)/$B64_FILE (use this for MACOS_CERTIFICATE secret)"

# 4) Optional: import into a temporary keychain to verify identity string
read -r -p "Verify in a temporary keychain now? [y/N]: " VERIFY
VERIFY=${VERIFY:-N}
if [[ "$VERIFY" == "y" || "$VERIFY" == "Y" ]]; then
  KC="verify-signing.keychain-db"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KC"
  security set-keychain-settings -lut 21600 "$KC"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC"

  security import "$P12_FILE" -P "$MACOS_CERTIFICATE_PWD" -A -t cert -f pkcs12 -k "$KC"
  security list-keychain -d user -s "$KC"

  echo
  echo "Identities found:"
  security find-identity -v -p codesigning "$KC" || true

  read -r -p "Delete temporary keychain now? [Y/n]: " DELKC
  DELKC=${DELKC:-Y}
  if [[ "$DELKC" == "Y" || "$DELKC" == "y" ]]; then
    security delete-keychain "$KC" || true
  fi
fi

echo
echo "Set these in GitHub → Settings → Secrets and variables → Actions:"
echo "- Secret MACOS_CERTIFICATE: contents of $(pwd)/$B64_FILE"
echo "- Secret MACOS_CERTIFICATE_PWD: value of MACOS_CERTIFICATE_PWD from .env"
echo "- Secret KEYCHAIN_PASSWORD: value of KEYCHAIN_PASSWORD from .env (or printed above)"
echo "- Secret APPLE_PASSWORD: your Apple ID app-specific password"
echo "- Variable APPLE_IDENTITY: EXACT Common Name from 'security find-identity -v' (e.g. \"$APPLE_IDENTITY\")"
echo "- Variable APPLE_ID: $APPLE_ID"
echo "- Variable APPLE_TEAM_ID: ${APPLE_TEAM_ID:-<your-team-id>}"

echo
echo "Done."