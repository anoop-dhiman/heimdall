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

    # Prompt for passphrase once
    read -s -p "Enter master passphrase: " PASSPHRASE
    echo ""

    if [ -z "$PASSPHRASE" ]; then
        echo "[-] Error: Passphrase cannot be empty."
        exit 1
    fi

    # Create an ephemeral in-memory temporary file (/dev/shm on Linux is pure RAM, wiped on exit)
    TMP_ENV=$(mktemp -p /dev/shm 2>/dev/null || mktemp)
    chmod 600 "$TMP_ENV"

    # Ensure temporary file is wiped immediately when script exits or is interrupted
    trap 'rm -f "$TMP_ENV"' EXIT INT TERM

    # Decrypt into the ephemeral memory file
    if ! echo "$PASSPHRASE" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$ENC_FILE" -pass stdin -out "$TMP_ENV" 2>/dev/null; then
        echo "[-] Decryption failed: Invalid passphrase or corrupted file."
        unset PASSPHRASE
        exit 1
    fi
    unset PASSPHRASE

    if [ ! -s "$TMP_ENV" ]; then
        echo "[-] Decryption resulted in empty configuration."
        exit 1
    fi

    echo "[+] Passphrase accepted. Launching Heimdall stack..."

    # Pass the ephemeral in-memory env file to Docker Compose
    docker compose --env-file "$TMP_ENV" up -d "$@"

    echo "================================================="
    echo " ✅ Heimdall is running!"
    echo " 🔒 Secrets loaded into memory; ephemeral file wiped."
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
