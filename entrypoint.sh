#!/usr/bin/env bash
set -eo pipefail

USER_HOME="${HOME:-/home/node}"

# Ensure user ownership over persistent volumes that may have been initialized as root
if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$USER_HOME/.claude" "$USER_HOME/.docker" /tmp/kube-cache 2>/dev/null || true
    sudo chown -R "$(id -u):$(id -g)" "$USER_HOME/.claude" "$USER_HOME/.docker" /tmp/kube-cache 2>/dev/null || true
    if [ -S "/var/run/docker.sock" ]; then
        sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
    fi
fi

echo "================================================="
echo " Starting Heimdall Remote Dev Agent Entrypoint"
echo " User: $(id -un) (UID: $(id -u), GID: $(id -g))"
echo " Home: $USER_HOME"
echo "================================================="

# 1. Configure Claude Code Settings for Bifrost Gateway
mkdir -p "$USER_HOME/.claude"
cat <<EOF > "$USER_HOME/.claude/settings.json"
{
  "env": {
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL:-http://bifrost:8080/anthropic}",
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-dummy-key}",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "${ANTHROPIC_DEFAULT_FABLE_MODEL:-gemini-3.1-pro-preview[1m]}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${ANTHROPIC_DEFAULT_OPUS_MODEL:-gemini-3.1-pro-preview[1m]}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${ANTHROPIC_DEFAULT_SONNET_MODEL:-gemini-3.8-flash[1m]}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-gemini-3.5-flash-lite[1m]}"
  },
  "tui": "fullscreen",
  "skipDangerousModePermissionPrompt": true,
  "theme": "auto",
  "model": "sonnet"
}
EOF
echo "[claude] Configured $USER_HOME/.claude/settings.json pointing to ${ANTHROPIC_BASE_URL:-http://bifrost:8080/anthropic}"

# Auto-restore ~/.claude.json from volume backup if missing, or initialize cleanly
if [ ! -f "$USER_HOME/.claude.json" ]; then
    LATEST_BACKUP=$(ls -t "$USER_HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -n 1 || true)
    if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
        echo "[claude] Restoring configuration from backup: $LATEST_BACKUP..."
        cp "$LATEST_BACKUP" "$USER_HOME/.claude.json"
    elif [ -f "$USER_HOME/.claude/.claude.json" ]; then
        cp "$USER_HOME/.claude/.claude.json" "$USER_HOME/.claude.json"
    else
        echo "[claude] Initializing clean $USER_HOME/.claude.json..."
        cat <<EOF > "$USER_HOME/.claude.json"
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF
    fi
fi
# Persist in mounted volume so it survives container recreations
cp "$USER_HOME/.claude.json" "$USER_HOME/.claude/.claude.json" 2>/dev/null || true

# 2. Configure Git User Identity & Safe Directory (container-scoped $USER_HOME/.gitconfig)
GIT_NAME="${GIT_USER_NAME:-Heimdall Dev Agent}"
GIT_EMAIL="${GIT_USER_EMAIL:-heimdall@internal}"

git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
git config --global --add safe.directory /workspace
git config --global --add safe.directory "*"
git config --global init.defaultBranch "${GIT_DEFAULT_BRANCH:-main}"

echo "[git] Configured Git user: $GIT_NAME <$GIT_EMAIL>"

# 3. Secure Container-Only Git Authentication (Zero host leakage)
# GIT_PAT is stored STRICTLY in container-only $USER_HOME/.git-credentials and $USER_HOME/.gitconfig.
# The mounted host repository at /workspace/.git is NEVER modified with tokens or credentials.
if [ -n "$GIT_PAT" ]; then
    DETECTED_REMOTE=$(git -C /workspace config --get remote.origin.url 2>/dev/null || echo "$GIT_REPO_URL")
    REPO_HOST=$(echo "$DETECTED_REMOTE" | sed -E -e 's|^https?://||' -e 's|/.*$||' -e 's|^.*@||')
    if [ -z "$REPO_HOST" ]; then
        REPO_HOST="${GIT_REPO_HOST:-github.com}"
    fi

    # Container-isolated credential file
    cat <<EOF > "$USER_HOME/.git-credentials"
https://${GIT_USERNAME:-x-access-token}:${GIT_PAT}@${REPO_HOST}
EOF
    chmod 600 "$USER_HOME/.git-credentials"

    # Configure helper globally for container user
    git config --global credential.helper "store --file $USER_HOME/.git-credentials"
    git config --global credential.useHttpPath true

    # Add rewrite rule in $USER_HOME/.gitconfig for HTTPS URLs targeting this host
    git config --global url."https://${GIT_USERNAME:-x-access-token}:${GIT_PAT}@${REPO_HOST}/".insteadOf "https://${REPO_HOST}/"

    echo "[git] Container-only GIT_PAT configured for host: ${REPO_HOST} (zero host leakage)"
else
    echo "[git] No GIT_PAT provided. Git will rely on existing host/SSH credentials if mounted."
fi

# 4. Docker CLI & Registry Authentication
if [ -S "/var/run/docker.sock" ]; then
    echo "[docker] Docker daemon socket detected at /var/run/docker.sock."
    docker version --format 'Client: {{.Client.Version}} | Server: {{.Server.Version}}' 2>/dev/null || echo "[docker] Connected to Docker socket."
else
    echo "[docker] Warning: /var/run/docker.sock not found. Image builds requiring host Docker daemon will fail unless socket is mounted."
fi

if [ -n "$DOCKER_USERNAME" ] && [ -n "$DOCKER_PASSWORD" ]; then
    REGISTRY_NAME="${DOCKER_REGISTRY:-Docker Hub}"
    echo "[docker] Logging in to registry ($REGISTRY_NAME)..."
    echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin "${DOCKER_REGISTRY:-}" || echo "[docker] Warning: docker login failed."
fi

# 5. Kubernetes (Kubeconfig Setup)
mkdir -p /tmp/kube-cache
export KUBECACHEDIR=/tmp/kube-cache

if [ -n "$KUBECONFIG_BASE64" ]; then
    echo "[kube] Injected KUBECONFIG_BASE64 detected. Writing to $USER_HOME/.kube/config..."
    mkdir -p "$USER_HOME/.kube" 2>/dev/null || true
    echo "$KUBECONFIG_BASE64" | base64 -d > "$USER_HOME/.kube/config" 2>/dev/null || echo "[kube] Notice: $USER_HOME/.kube is read-only mounted."
elif [ -n "$KUBECONFIG_RAW" ]; then
    echo "[kube] Injected KUBECONFIG_RAW detected. Writing to $USER_HOME/.kube/config..."
    mkdir -p "$USER_HOME/.kube" 2>/dev/null || true
    echo "$KUBECONFIG_RAW" > "$USER_HOME/.kube/config" 2>/dev/null || echo "[kube] Notice: $USER_HOME/.kube is read-only mounted."
fi

if [ -f "$USER_HOME/.kube/config" ]; then
    echo "[kube] Kubeconfig available. Current cluster context:"
    kubectl config current-context 2>/dev/null || echo "[kube] Context not active."
else
    echo "[kube] Warning: $USER_HOME/.kube/config not found. Mount ~/.kube:$USER_HOME/.kube:ro or provide KUBECONFIG_BASE64."
fi

# 6. Verify Host Repository Mount
if [ -d "/workspace/.git" ]; then
    CURRENT_BRANCH=$(git -C /workspace rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    CURRENT_COMMIT=$(git -C /workspace log -1 --oneline 2>/dev/null || echo "empty")
    echo "[git] Host repository mounted at /workspace (Branch: ${CURRENT_BRANCH} | Commit: ${CURRENT_COMMIT})"
else
    echo "[git] Info: /workspace does not currently contain a .git directory. Ensure HOST_REPO_PATH is configured in .env."
fi

cd /workspace
echo "================================================="
echo " Environment ready. Executing CMD: $@"
echo "================================================="

exec "$@"
