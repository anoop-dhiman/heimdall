#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENC_FILE=".env.enc"
ENV_FILE=".env"

echo "================================================="
echo " Heimdall Secret Decryption"
echo "================================================="

if [ ! -f "$ENC_FILE" ]; then
    echo "[-] Error: Encrypted file '$ENC_FILE' not found."
    exit 1
fi

if [ -f "$ENV_FILE" ]; then
    read -rp "[!] '$ENV_FILE' already exists. Overwrite? [y/N]: " OVERWRITE
    if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

echo "[+] Decrypting '$ENC_FILE' -> '$ENV_FILE'..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$ENC_FILE" -out "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "[+] Successfully decrypted to '$ENV_FILE' (permissions: 600)."
echo "[!] REMINDER: Run './encrypt-env.sh' to re-encrypt and remove plaintext after editing!"
