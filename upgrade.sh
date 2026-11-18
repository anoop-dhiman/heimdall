#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENC_FILE=".env.enc"
ENV_FILE=".env"

echo "================================================="
echo " Heimdall Upgrade"
echo "================================================="
echo "Pulls published images, rebuilds local images,"
echo "then recreates containers. Volumes are kept."
echo ""

run_upgrade() {
    local env_file="${1:-}"
    shift
    local env_args=()
    if [ -n "$env_file" ]; then
        env_args=(--env-file "$env_file")
    fi

    echo "[+] Pulling published images (bifrost)..."
    docker compose "${env_args[@]}" pull --ignore-buildable "$@"

    echo "[+] Building local images (heimdall)..."
    docker compose "${env_args[@]}" build --pull "$@"

    echo "[+] Recreating services on the new images..."
    docker compose "${env_args[@]}" up -d --force-recreate --remove-orphans "$@"

    echo "================================================="
    echo " ✅ Heimdall upgraded and restarted."
    echo "================================================="
    docker compose "${env_args[@]}" ps
    echo ""
    echo "To view live logs: docker compose logs -f"
}

if [ -f "$ENC_FILE" ]; then
    echo "[+] Encrypted secrets file '$ENC_FILE' detected."

    read -s -p "Enter master passphrase: " PASSPHRASE
    echo ""

    if [ -z "$PASSPHRASE" ]; then
        echo "[-] Error: Passphrase cannot be empty."
        exit 1
    fi

    TMP_ENV=$(mktemp -p /dev/shm 2>/dev/null || mktemp)
    chmod 600 "$TMP_ENV"
    trap 'rm -f "$TMP_ENV"' EXIT INT TERM

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

    echo "[+] Passphrase accepted. Upgrading Heimdall stack..."
    run_upgrade "$TMP_ENV" "$@"

elif [ -f "$ENV_FILE" ]; then
    echo "[!] WARNING: Upgrading using plaintext '$ENV_FILE'."
    echo "    Please run './encrypt-env.sh' to secure your secrets."
    echo ""
    read -rp "Continue upgrading with plaintext .env? [y/N]: " PROCEED
    if [[ ! "$PROCEED" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    run_upgrade "" "$@"

else
    echo "[-] Error: Neither '$ENC_FILE' nor '$ENV_FILE' found."
    echo "    1. Run 'cp .env.example .env' and add your secrets."
    echo "    2. Run './encrypt-env.sh' to encrypt and protect them."
    echo "    3. Run './upgrade.sh' to pull, build, and restart."
    exit 1
fi
