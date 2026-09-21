#!/usr/bin/env bash
set -eo pipefail

echo "================================================="
echo " Starting Heimdall Remote Dev Agent Entrypoint"
echo "================================================="

# 1. Configure Claude Code Settings for Bifrost Gateway
mkdir -p /root/.claude
cat <<EOF > /root/.claude/settings.json
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
echo "[claude] Configured /root/.claude/settings.json pointing to ${ANTHROPIC_BASE_URL:-http://bifrost:8080/anthropic}"

# 2. Configure Git User Identity & Safe Directory (container-scoped /root/.gitconfig)
GIT_NAME="${GIT_USER_NAME:-Heimdall Dev Agent}"
GIT_EMAIL="${GIT_USER_EMAIL:-heimdall@internal}"

git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
git config --global --add safe.directory /workspace
git config --global --add safe.directory "*"
git config --global init.defaultBranch "${GIT_DEFAULT_BRANCH:-main}"

echo "[git] Configured Git user: $GIT_NAME <$GIT_EMAIL>"

# 3. Secure Container-Only Git Authentication (Zero host leakage)
# GIT_PAT is stored STRICTLY in container-only /root/.git-credentials and /root/.gitconfig.
# The mounted host repository at /workspace/.git is NEVER modified with tokens or credentials.
if [ -n "$GIT_PAT" ]; then
    DETECTED_REMOTE=$(git -C /workspace config --get remote.origin.url 2>/dev/null || echo "$GIT_REPO_URL")
    REPO_HOST=$(echo "$DETECTED_REMOTE" | sed -E -e 's|^https?://||' -e 's|/.*$||' -e 's|^.*@||')
    if [ -z "$REPO_HOST" ]; then
        REPO_HOST="${GIT_REPO_HOST:-github.com}"
    fi

    # Container-isolated credential file
    cat <<EOF > /root/.git-credentials
https://${GIT_USERNAME:-x-access-token}:${GIT_PAT}@${REPO_HOST}
EOF
    chmod 600 /root/.git-credentials

    # Configure helper globally for container root
    git config --global credential.helper "store --file /root/.git-credentials"
    git config --global credential.useHttpPath true

    # Add rewrite rule in /root/.gitconfig for HTTPS URLs targeting this host
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
    echo "[kube] Injected KUBECONFIG_BASE64 detected. Writing to /root/.kube/config..."
    mkdir -p /root/.kube 2>/dev/null || true
    echo "$KUBECONFIG_BASE64" | base64 -d > /root/.kube/config 2>/dev/null || echo "[kube] Notice: /root/.kube is read-only mounted."
elif [ -n "$KUBECONFIG_RAW" ]; then
    echo "[kube] Injected KUBECONFIG_RAW detected. Writing to /root/.kube/config..."
    mkdir -p /root/.kube 2>/dev/null || true
    echo "$KUBECONFIG_RAW" > /root/.kube/config 2>/dev/null || echo "[kube] Notice: /root/.kube is read-only mounted."
fi

if [ -f "/root/.kube/config" ]; then
    echo "[kube] Kubeconfig available. Current cluster context:"
    kubectl config current-context 2>/dev/null || echo "[kube] Context not active."
else
    echo "[kube] Warning: /root/.kube/config not found. Mount ~/.kube:/root/.kube:ro or provide KUBECONFIG_BASE64."
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
