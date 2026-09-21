#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENC_FILE=".env.enc"
ENV_FILE=".env"

echo "================================================="
echo " Heimdall Startup (Secure Memory Decryption)"
echo "================================================="

if [ -f "$ENC_FILE" ]; then
    echo "[+] Encrypted secrets file '$ENC_FILE' detected."
    echo "[!] Enter your master passphrase to decrypt into memory:"

    # Verify passphrase by attempting decryption into a test pipe first
    DECRYPT_CHECK=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$ENC_FILE" 2>&1 >/dev/null || true)
    if [ -n "$DECRYPT_CHECK" ]; then
        echo "[-] Decryption failed: Invalid passphrase or corrupted file."
        exit 1
    fi

    echo "[+] Passphrase accepted. Launching Heimdall stack in memory..."

    # Stream decrypted secrets directly into Docker Compose in RAM (never touches disk)
    docker compose --env-file <(openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$ENC_FILE") up -d "$@"

    echo "================================================="
    echo " ✅ Heimdall is running!"
    echo " 🔒 Secrets were decrypted into memory only."
    echo " 📂 Zero plaintext secrets on disk."
    echo "================================================="
    echo "To view live logs: docker compose logs -f"
    echo "To stop:           ./stop.sh"

elif [ -f "$ENV_FILE" ]; then
    echo "[!] WARNING: Starting using plaintext '$ENV_FILE'."
    echo "    Any other user with login access to this host can view your credentials!"
    echo "    Please run './encrypt-env.sh' to secure your secrets."
    echo ""
    read -rp "Continue starting with plaintext .env? [y/N]: " PROCEED
    if [[ ! "$PROCEED" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    docker compose up -d "$@"
    echo "[+] Heimdall is running."

else
    echo "[-] Error: Neither '$ENC_FILE' nor '$ENV_FILE' found."
    echo "    1. Run 'cp .env.example .env' and add your secrets."
    echo "    2. Run './encrypt-env.sh' to encrypt and protect them."
    echo "    3. Run './start.sh' to launch."
    exit 1
fi
