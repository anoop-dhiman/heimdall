#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
ENC_FILE=".env.enc"

echo "================================================="
echo " Heimdall Secret Encryption (OpenSSL AES-256-CBC)"
echo "================================================="

if [ ! -f "$ENV_FILE" ]; then
    echo "[-] Error: '$ENV_FILE' not found in $(pwd)"
    echo "    Please create '$ENV_FILE' from '.env.example' first."
    exit 1
fi

echo "[+] Encrypting '$ENV_FILE' -> '$ENC_FILE'..."
echo "[!] You will be prompted to enter and verify a master passphrase."
echo "    Remember this passphrase! It will be required every time you start Heimdall."
echo ""

# Encrypt with AES-256-CBC with PBKDF2 and high iteration count
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -in "$ENV_FILE" -out "$ENC_FILE"

# Restrict permissions
chmod 600 "$ENC_FILE"
chmod 700 "$SCRIPT_DIR"

echo ""
echo "[+] Successfully created encrypted secrets file: '$ENC_FILE' (permissions: 600)"
echo ""

read -rp "Would you like to securely delete the plaintext '$ENV_FILE' now? [Y/n]: " CONFIRM
CONFIRM=${CONFIRM:-Y}

if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    # Secure overwrite if shred is available, otherwise rm
    if command -v shred >/dev/null 2>&1; then
        shred -u -z -n 3 "$ENV_FILE"
    else
        rm -f "$ENV_FILE"
    fi
    echo "[+] Plaintext '$ENV_FILE' deleted. Zero plaintext secrets on disk!"
else
    echo "[!] Warning: '$ENV_FILE' left on disk. Make sure to delete it manually before leaving a shared host."
fi

echo ""
echo "Next step: Run './start.sh' to decrypt into memory and launch Heimdall."
