# Heimdall 🛡️⚡

A self-contained DevOps & engineering agent powered by **Claude Code CLI** and driven via **Telegram**. Use it to inspect Kubernetes clusters, build & push Docker images, edit code, and deploy Helm charts directly from chat.

---

## Architecture

```text
       Telegram Chat (User)
                │
                ▼ (Long-Polling)
┌────────────────────────────────────────────────────────┐
│ Docker Compose Stack                                   │
│                                                        │
│   ┌────────────────────────────────────────────────┐   │
│   │ bifrost (:8080)                                │   │
│   │  AI Gateway translating Anthropic to Gemini    │   │
│   └───────────────────────▲────────────────────────┘   │
│                           │ (http://bifrost:8080)      │
│   ┌───────────────────────┴────────────────────────┐   │
│   │ heimdall                                       │   │
│   │  • Telegram Bot Controller (bot.mjs)           │   │
│   │  • Headless Claude Code CLI                    │   │
│   │  • Toolchain: Docker, Kubectl, Helm, Git, Py   │   │
│   └───────────────────────┬────────────────────────┘   │
└───────────────────────────┼────────────────────────────┘
                            ▼
          Mounted Workspace & Cluster Resources
```

---

## Features

- **ChatOps via Telegram**: Command Claude Code from mobile or desktop Telegram using long-polling (no open ports or webhooks required).
- **Gemini via Bifrost**: Routes Claude Code through local Bifrost sidecar to Google Gemini models (`gemini-3.8-flash`, `gemini-3.1-pro-preview`).
- **DevOps Toolchain**: Pre-installed `docker`, `kubectl`, `helm 3`, `node 22`, `git`, and `python3`.
- **Host Git Mounting**: Mounts your repository from host (`HOST_REPO_PATH`).
- **Container-Isolated PAT**: `GIT_PAT` is stored strictly inside container memory/config (`/root/.git-credentials`) and never touches the host's `.git/config`.
- **In-Memory Encryption**: Encrypts `.env` to `.env.enc` with OpenSSL AES-256; `./start.sh` decrypts directly into memory with zero plaintext credentials on disk.
- **Destructive Action Guardrail**: Asks for user confirmation in chat before running destructive commands (`kubectl delete`, `helm uninstall`, `git push --force`, `rm -rf`, `docker system prune`).

---

## Quick Start

### 1. Clone & Configure

```bash
git clone https://github.com/anoop-dhiman/heimdall.git
cd heimdall/

cp .env.example .env
```

Edit `.env` with your credentials:
- `TELEGRAM_BOT_TOKEN`: From [@BotFather](https://t.me/botfather).
- `ALLOWED_TELEGRAM_USER_IDS`: Your numeric ID from [@userinfobot](https://t.me/userinfobot).
- `GOOGLE_API_KEY`: Your Gemini API key.
- `HOST_REPO_PATH`: Path to your checked-out repository on the host.
- `GIT_PAT`: Personal Access Token for Git push/pull.
- `KUBECONFIG_BASE64`: Cluster kubeconfig (`cat ~/.kube/config | base64 | tr -d '\n'`) or mount `~/.kube` in `docker-compose.yml`.

### 2. Encrypt Secrets & Start

```bash
# Encrypt .env -> .env.enc and shred plaintext file
./encrypt-env.sh

# Decrypt directly into memory and launch stack
./start.sh
```

View logs:
```bash
docker compose logs -f
```

Stop stack:
```bash
./stop.sh
```

To edit credentials later:
```bash
./decrypt-env.sh   # Decrypts back to .env
# Edit .env...
./encrypt-env.sh   # Re-encrypts and shreds plaintext
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/sessions` | Interactive session manager with inline buttons to switch, create, and delete Claude sessions |
| `/switch <name>` | Switch active conversation to a session by name (e.g. `/switch k8s-debug`) |
| `/new [name]` | Reset active session, or create and switch to a new named session (`/new <name>`) |
| `/current` | Display details for the active session (name, Claude session ID, last active) |
| `/delete [name]` | Delete a saved session (or open the delete picker menu) |
| `/status` | View task, active session, Git branch/commit, Kubernetes context, and Docker state |
| `/cancel` | Abort currently running task |
| `/help` | Show command menu and usage instructions |
