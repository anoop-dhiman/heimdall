FROM node:22-bookworm-slim

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install base utilities, Git, OpenSSH, sudo, and Python 3
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    openssh-client \
    ca-certificates \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    procps \
    gnupg \
    apt-transport-https \
    lsb-release \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Docker CLI (client) and Buildx/Compose plugins via official Docker repository
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce-cli \
        docker-buildx-plugin \
        docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# 3. Install Kubectl (official stable release, multi-arch compatible)
RUN ARCH=$(dpkg --print-architecture) \
    && KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt) \
    && curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm -f kubectl

# 4. Install Helm 3 via official install script
RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
    && chmod 700 get_helm.sh \
    && ./get_helm.sh \
    && rm -f get_helm.sh

# 5. Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# 6. Configure non-root user (node: matching host UID/GID) with passwordless sudo & docker group
# Claude Code blocks --dangerously-skip-permissions if executed by root (UID 0)
ARG UID=1001
ARG GID=1001
RUN (groupmod -g ${GID} node 2>/dev/null || groupadd -g ${GID} node 2>/dev/null || true) \
    && (usermod -u ${UID} -g ${GID} node 2>/dev/null || true) \
    && (groupadd -g 999 docker 2>/dev/null || groupadd docker 2>/dev/null || true) \
    && usermod -aG sudo,docker node \
    && echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && chown -R node:node /home/node

# 7. Setup App directory
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY bot.mjs ./
COPY entrypoint.sh ./
COPY safety-prompt.txt ./
RUN chmod +x /app/entrypoint.sh

# 8. Setup Workspace and config directories for user 'node'
RUN mkdir -p /workspace /home/node/.claude /home/node/.kube /home/node/.docker /tmp/kube-cache \
    && chown -R node:node /app /workspace /home/node /tmp/kube-cache

USER node
ENV HOME=/home/node
WORKDIR /workspace

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/bot.mjs"]
