#!/usr/bin/env node

import { Telegraf } from 'telegraf';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration & Environment Setup
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';

// Parse allowed Telegram user IDs (comma-separated integers/strings)
const allowedUserIds = (process.env.ALLOWED_TELEGRAM_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

console.log('----------------------------------------------------');
console.log('🤖 Starting Claude Remote Dev Agent Telegram Bot');
console.log(`📂 Workspace Directory: ${WORKSPACE_DIR}`);
console.log(`🔒 Allowed User IDs: ${allowedUserIds.length > 0 ? allowedUserIds.join(', ') : 'ALL (WARNING: Open access!)'}`);
console.log('----------------------------------------------------');

const bot = new Telegraf(BOT_TOKEN);

// In-memory session tracking per chat
// Map<chatId, { sessionId: string|null, runningProcess: ChildProcess|null, isCanceling: boolean, progressUpdater: ProgressUpdater|null }>
const chatSessions = new Map();

function getSession(chatId) {
  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, {
      sessionId: null,
      runningProcess: null,
      isCanceling: false,
      progressUpdater: null,
    });
  }
  return chatSessions.get(chatId);
}

// ---------------------------------------------------------------------------
// Authentication & Authorization Middleware
// ---------------------------------------------------------------------------
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  if (allowedUserIds.length > 0 && !allowedUserIds.includes(userId)) {
    console.warn(`[auth] Unauthorized access rejected for user ID ${userId} (@${ctx.from?.username || 'unknown'})`);
    if (ctx.chat?.type === 'private') {
      await ctx
        .reply(
          `⛔ *Access Denied*\n\nYour Telegram User ID is \`${userId}\`.\nYou are not authorized to use this bot.`,
          { parse_mode: 'Markdown' }
        )
        .catch(() => {});
    }
    return;
  }
  return next();
});

// ---------------------------------------------------------------------------
// Helper Utilities
// ---------------------------------------------------------------------------
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function truncateString(str, maxLen = 80) {
  if (!str) return '';
  const singleLine = str.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.substring(0, maxLen - 3) + '...';
}

function getSystemStatus() {
  const status = {
    gitBranch: 'Unknown',
    gitCommit: 'Unknown',
    gitDirty: 'Unknown',
    k8sContext: 'Not configured',
    dockerStatus: 'Not connected',
  };

  // Git info
  try {
    if (fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) {
      status.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: WORKSPACE_DIR,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      status.gitCommit = execSync('git log -1 --oneline', {
        cwd: WORKSPACE_DIR,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      const statusOutput = execSync('git status --porcelain', {
        cwd: WORKSPACE_DIR,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      status.gitDirty = statusOutput ? `${statusOutput.split('\n').length} modified file(s)` : 'Clean';
    } else {
      status.gitBranch = 'No git repository in workspace';
    }
  } catch (err) {
    status.gitBranch = `Error: ${err.message}`;
  }

  // Kubectl info
  try {
    const ctx = execSync('kubectl config current-context 2>/dev/null', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (ctx) {
      status.k8sContext = ctx;
    }
  } catch {}

  // Docker info
  try {
    const dVer = execSync('docker version --format "Client: {{.Client.Version}} | Server: {{.Server.Version}}" 2>/dev/null', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (dVer) {
      status.dockerStatus = dVer;
    }
  } catch {
    if (fs.existsSync('/var/run/docker.sock')) {
      status.dockerStatus = 'Socket mounted (Daemon status check failed)';
    } else {
      status.dockerStatus = 'Socket /var/run/docker.sock not mounted';
    }
  }

  return status;
}

// ---------------------------------------------------------------------------
// Throttled Progress Streaming Class
// ---------------------------------------------------------------------------
class ProgressUpdater {
  constructor(ctx, statusMsgId) {
    this.ctx = ctx;
    this.statusMsgId = statusMsgId;
    this.toolHistory = [];
    this.pendingText = '';
    this.lastSentText = '';
    this.lastUpdateTime = 0;
    this.minIntervalMs = 1500; // Throttle to 1 update every 1.5 seconds to avoid Telegram 429
    this.updateTimer = null;
    this.isClosed = false;
  }

  recordToolUse(toolName, toolInput) {
    if (this.isClosed) return;

    let detail = '';
    if (toolInput) {
      if (typeof toolInput === 'string') {
        detail = toolInput;
      } else if (toolInput.command) {
        detail = toolInput.command;
      } else if (toolInput.file_path) {
        detail = toolInput.file_path;
      } else if (toolInput.path) {
        detail = toolInput.path;
      } else if (toolInput.pattern) {
        detail = toolInput.pattern;
      } else if (toolInput.query) {
        detail = toolInput.query;
      } else if (toolInput.url) {
        detail = toolInput.url;
      } else {
        try {
          detail = JSON.stringify(toolInput);
        } catch {}
      }
    }

    const shortDetail = truncateString(detail, 60);
    const item = shortDetail ? `🔧 *${toolName}*: \`${shortDetail}\`` : `🔧 *${toolName}*`;
    this.toolHistory.push(item);

    // Keep last 3 tools in display
    const recent = this.toolHistory.slice(-3).join('\n');
    const updateText = `⚡ *Claude Code in progress...*\n\n${recent}\n\n⏳ _Executing tools..._`;
    this.requestUpdate(updateText);
  }

  requestUpdate(text) {
    if (this.isClosed || text === this.lastSentText) return;
    this.pendingText = text;

    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;

    if (elapsed >= this.minIntervalMs) {
      this.sendUpdate();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        this.sendUpdate();
      }, this.minIntervalMs - elapsed);
    }
  }

  async sendUpdate() {
    if (this.isClosed || !this.pendingText || this.pendingText === this.lastSentText) return;
    const textToSend = this.pendingText;
    this.lastSentText = textToSend;
    this.lastUpdateTime = Date.now();

    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        this.statusMsgId,
        undefined,
        textToSend,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      const msg = err.message || '';
      // Ignore if message wasn't modified or temporary rate limit
      if (!msg.includes('message is not modified')) {
        // If markdown formatting failed, fallback to plain text
        if (msg.includes('can\'t parse entities')) {
          await this.ctx.telegram
            .editMessageText(
              this.ctx.chat.id,
              this.statusMsgId,
              undefined,
              textToSend.replace(/[*_`]/g, '')
            )
            .catch(() => {});
        }
      }
    }
  }

  async close(finalText) {
    this.isClosed = true;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (finalText) {
      try {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat.id,
          this.statusMsgId,
          undefined,
          finalText,
          { parse_mode: 'Markdown' }
        );
      } catch {
        try {
          await this.ctx.telegram.editMessageText(
            this.ctx.chat.id,
            this.statusMsgId,
            undefined,
            finalText.replace(/[*_`]/g, '')
          );
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bot Commands
// ---------------------------------------------------------------------------

// /start and /help
bot.command(['start', 'help'], async (ctx) => {
  const helpMessage = `🛡️ *Heimdall: DevOps Guardian*

I am Heimdall, your remote DevOps guardian standing on the Bifrost bridge. Send me instructions and I will inspect Kubernetes, build & push Docker images, edit code, and deploy Helm charts directly from Telegram.

*Available Commands:*
• /new - Reset session (starts a fresh Claude conversation context)
• /cancel - Abort currently running task
• /status - View task, Git, Kubernetes, and Docker status
• /help - Display this help guide

*Examples:*
• "Check why pods in namespace staging are crashlooping"
• "Inspect the git diff and summarize recent changes"
• "Build and push the docker image tagged myrepo/app:v1.0"
• "Deploy helm upgrade for the web service"
`;
  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

// /new: Reset session context
bot.command('new', async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (session.runningProcess) {
    return ctx.reply(
      '⚠️ A task is currently running. Please cancel it first with /cancel before resetting the session.'
    );
  }

  const oldId = session.sessionId;
  session.sessionId = null;
  console.log(`[session] Reset session for chat ${ctx.chat.id} (previous: ${oldId || 'none'})`);
  await ctx.reply('✨ *Session reset.* Conversation context has been cleared. The next message will begin a fresh session.', {
    parse_mode: 'Markdown',
  });
});

// /cancel: Kill active Claude execution
bot.command('cancel', async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (!session.runningProcess) {
    return ctx.reply('ℹ️ No active task is running in this chat.');
  }

  session.isCanceling = true;
  console.log(`[session] Canceling process PID ${session.runningProcess.pid} for chat ${ctx.chat.id}`);

  try {
    session.runningProcess.kill('SIGINT');
    setTimeout(() => {
      if (session.runningProcess) {
        try {
          session.runningProcess.kill('SIGKILL');
        } catch {}
      }
    }, 2500);
  } catch (err) {
    console.error('[cancel] Error signaling process:', err);
  }

  if (session.progressUpdater) {
    await session.progressUpdater.close('🛑 *Execution canceled by user.*');
  }

  await ctx.reply('🛑 Execution has been canceled.');
});

// /status: Environment & state info
bot.command('status', async (ctx) => {
  const session = getSession(ctx.chat.id);
  const sys = getSystemStatus();

  const isRunning = Boolean(session.runningProcess);
  const taskStatus = isRunning ? '🏃 *Running*' : '💤 *Idle*';
  const sessionStatus = session.sessionId ? `\`${session.sessionId}\`` : '_None (New session)_';

  const statusMsg = `📊 *Heimdall Status*

• *Task State:* ${taskStatus}
• *Claude Session:* ${sessionStatus}
• *Workspace:* \`${WORKSPACE_DIR}\`
• *Git Branch:* \`${sys.gitBranch}\`
• *Last Commit:* \`${sys.gitCommit}\`
• *Working Tree:* ${sys.gitDirty}
• *K8s Context:* \`${sys.k8sContext}\`
• *Docker:* \`${sys.dockerStatus}\`
`;

  await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
});

// ---------------------------------------------------------------------------
// Text Message Handler (Claude Execution)
// ---------------------------------------------------------------------------
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    // Ignore unhandled commands
    return;
  }

  const session = getSession(ctx.chat.id);
  if (session.runningProcess) {
    return ctx.reply('⏳ A task is already in progress. Use /cancel to abort it, or wait for it to finish.');
  }

  session.isCanceling = false;

  // Send initial progress message
  const statusMsg = await ctx.reply('🚀 *Starting Claude Code...*', { parse_mode: 'Markdown' });
  const updater = new ProgressUpdater(ctx, statusMsg.message_id);
  session.progressUpdater = updater;

  // Typing indicator interval (sends action every 4 seconds)
  const typingInterval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);
  ctx.sendChatAction('typing').catch(() => {});

  // Build command arguments
  // Command structure: claude -p "$prompt" --output-format stream-json --bare --dangerously-skip-permissions --permission-prompts none
  const args = [
    '-p',
    text,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-prompts',
    'none',
  ];

  const userHome = process.env.HOME || '/home/node';
  const settingsPath = path.join(userHome, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    args.push('--settings', settingsPath);
  } else if (fs.existsSync('/root/.claude/settings.json')) {
    args.push('--settings', '/root/.claude/settings.json');
  }

  // Safety Guardrail: Force human-in-the-loop confirmation for any destructive commands
  const safetyPromptPath = fs.existsSync('/app/safety-prompt.txt')
    ? '/app/safety-prompt.txt'
    : fs.existsSync(path.join(process.cwd(), 'safety-prompt.txt'))
    ? path.join(process.cwd(), 'safety-prompt.txt')
    : null;

  if (safetyPromptPath) {
    args.push('--append-system-prompt-file', safetyPromptPath);
  }

  if (session.sessionId) {
    args.push('--resume', session.sessionId);
    console.log(`[claude] Resuming existing session: ${session.sessionId}`);
  } else {
    console.log('[claude] Starting new session');
  }

  const startTime = Date.now();
  let finalResultText = '';
  let latestAssistantText = '';
  const allAssistantTexts = [];
  let streamedText = '';
  let nonJsonOutput = '';
  let detectedSessionId = null;
  let stderrBuffer = '';

  console.log(`[claude] Spawning: ${CLAUDE_PATH} ${args.join(' ')} (cwd: ${WORKSPACE_DIR})`);

  let child;
  try {
    child = spawn(CLAUDE_PATH, args, {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
      // Pass 'ignore' for stdin (equivalent to < /dev/null) so Claude Code does not wait 3s for input
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    clearInterval(typingInterval);
    session.progressUpdater = null;
    await updater.close('❌ *Failed to spawn Claude process.*');
    return ctx.reply(`❌ Failed to start Claude CLI: ${err.message}`);
  }

  session.runningProcess = child;

  // Parse stream-json from stdout line by line
  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);

      // Check for session ID in various fields
      if (event.session_id) detectedSessionId = event.session_id;
      else if (event.sessionId) detectedSessionId = event.sessionId;
      else if (event.session?.id) detectedSessionId = event.session.id;

      // 1. Detect tool use
      if (event.type === 'tool_use' || event.type === 'tool_call') {
        updater.recordToolUse(event.name || event.tool || 'Tool', event.input || event.arguments);
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        updater.recordToolUse(event.content_block.name || 'Tool', event.content_block.input);
      }

      // 2. Capture 'assistant' message events (Claude's conversational turns & answers)
      if (event.type === 'assistant' && event.message?.content) {
        let turnText = '';
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            turnText += block.text;
          } else if (block.type === 'tool_use') {
            updater.recordToolUse(block.name || 'Tool', block.input);
          }
        }
        if (turnText.trim()) {
          latestAssistantText = turnText.trim();
          allAssistantTexts.push(turnText.trim());
        }
      }

      // 3. Direct event.content arrays
      if (Array.isArray(event.content)) {
        let blockText = '';
        for (const block of event.content) {
          if (block.type === 'text' && block.text) {
            blockText += block.text;
          } else if (block.type === 'tool_use') {
            updater.recordToolUse(block.name || 'Tool', block.input);
          }
        }
        if (blockText.trim()) {
          latestAssistantText = blockText.trim();
          allAssistantTexts.push(blockText.trim());
        }
      }

      // 4. Streaming deltas (stream_event and content_block_delta)
      if (event.type === 'stream_event') {
        const streamDelta = event.event?.delta;
        if (streamDelta?.text) {
          streamedText += streamDelta.text;
        }
      } else if (event.type === 'content_block_delta' && event.delta?.text) {
        streamedText += event.delta.text;
      } else if (event.type === 'text' && event.text) {
        streamedText += event.text;
      }

      // 5. Final 'result' event
      if (event.type === 'result') {
        if (typeof event.result === 'string' && event.result.trim()) {
          finalResultText = event.result.trim();
        } else if (event.result?.text && typeof event.result.text === 'string') {
          finalResultText = event.result.text.trim();
        }
        if (event.session_id) detectedSessionId = event.session_id;
      }
    } catch {
      // Non-JSON line fallback (e.g. raw output or error trace)
      nonJsonOutput += trimmed + '\n';
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  child.on('error', async (err) => {
    console.error('[claude] Process error:', err);
    clearInterval(typingInterval);
    session.runningProcess = null;
    session.progressUpdater = null;
    await updater.close('❌ *Process encountered an error.*');
    await ctx.reply(`❌ Execution error: ${err.message}`);
  });

  child.on('close', async (code, signal) => {
    clearInterval(typingInterval);
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const wasCanceled = session.isCanceling || signal === 'SIGINT' || signal === 'SIGTERM';

    session.runningProcess = null;
    session.progressUpdater = null;
    session.isCanceling = false;

    if (detectedSessionId) {
      session.sessionId = detectedSessionId;
      console.log(`[session] Saved session ID: ${detectedSessionId}`);
    }

    if (wasCanceled) {
      await updater.close('🛑 *Execution canceled.*');
      return;
    }

    // Determine the response text in order of priority:
    // 1. finalResultText (if present and non-empty)
    // 2. latestAssistantText (in multi-tool runs, the last assistant message is the final answer)
    // 3. allAssistantTexts combined (if multiple assistant comments)
    // 4. streamedText (if incremental token stream captured)
    // 5. nonJsonOutput (raw stdout fallback)
    let outputText = '';
    if (finalResultText && finalResultText.trim()) {
      outputText = finalResultText.trim();
    } else if (latestAssistantText && latestAssistantText.trim()) {
      outputText = latestAssistantText.trim();
    } else if (allAssistantTexts.length > 0) {
      outputText = allAssistantTexts.join('\n\n').trim();
    } else if (streamedText && streamedText.trim()) {
      outputText = streamedText.trim();
    } else if (nonJsonOutput && nonJsonOutput.trim()) {
      outputText = nonJsonOutput.trim();
    }

    if (code !== 0 && !outputText) {
      await updater.close(`❌ *Claude exited with code ${code}* (${durationSec}s)`);
      const errDetails = stderrBuffer.trim() || 'No stderr details captured.';
      return ctx.reply(`⚠️ *Execution Failed (Exit Code ${code}):*\n\`\`\`\n${truncateString(errDetails, 1000)}\n\`\`\``, {
        parse_mode: 'Markdown',
      });
    }

    if (!outputText) {
      outputText = `_Task completed in ${durationSec}s with no textual output._`;
    }

    await updater.close(`✅ *Completed in ${durationSec}s*`);

    // Handle message delivery with smart splitting
    // For outputs up to 12,000 characters (~3 Telegram messages), send directly in chat.
    // For truly massive outputs (>12,000 characters), send as .md attachment with preview.
    const MAX_CHAT_LENGTH = parseInt(process.env.MAX_CHAT_MESSAGE_LENGTH || '12000', 10);

    if (outputText.length <= MAX_CHAT_LENGTH) {
      const chunks = splitIntoTelegramChunks(outputText, 3800);
      for (const chunk of chunks) {
        await sendSafeTelegramMessage(ctx, chunk);
      }
    } else {
      // Truly massive output: send preview snippet in chat + full output as attachment
      const filename = `claude-response-${Date.now()}.md`;
      const previewText = outputText.slice(0, 800).trim() + '\n\n... _(Full output attached below)_';
      await sendSafeTelegramMessage(ctx, previewText);

      console.log(`[response] Output length ${outputText.length} > ${MAX_CHAT_LENGTH}. Sending as document attachment: ${filename}`);
      try {
        await ctx.replyWithDocument(
          {
            source: Buffer.from(outputText, 'utf-8'),
            filename,
          },
          {
            caption: `📄 *Full Response Attached* (${outputText.length} characters).\nFile: \`${filename}\``,
            parse_mode: 'Markdown',
          }
        );
      } catch (attachErr) {
        console.error('[response] Failed to send document attachment, falling back to chunking:', attachErr);
        const chunks = splitIntoTelegramChunks(outputText, 3800);
        for (const chunk of chunks) {
          await sendSafeTelegramMessage(ctx, chunk);
        }
      }
    }
  });
});

// Smart paragraph & line boundary chunker for Telegram messages
function splitIntoTelegramChunks(text, maxChunkSize = 3800) {
  if (text.length <= maxChunkSize) return [text];
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Prefer splitting at double newlines (paragraphs)
    let splitIdx = remaining.lastIndexOf('\n\n', maxChunkSize);
    if (splitIdx === -1 || splitIdx < maxChunkSize * 0.4) {
      // Fallback: single newline
      splitIdx = remaining.lastIndexOf('\n', maxChunkSize);
    }
    if (splitIdx === -1 || splitIdx < maxChunkSize * 0.4) {
      // Fallback: space
      splitIdx = remaining.lastIndexOf(' ', maxChunkSize);
    }
    if (splitIdx === -1) {
      // Hard split
      splitIdx = maxChunkSize;
    }

    chunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

// Send message with Markdown formatting and automatic fallback to plain text if Markdown parsing fails
async function sendSafeTelegramMessage(ctx, text) {
  if (!text || !text.trim()) return;
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.warn('[response] Markdown formatting failed, sending as plain text:', err.message);
    try {
      await ctx.reply(text.replace(/[*_`\[\]()]/g, ''));
    } catch {
      await ctx.reply(text);
    }
  }
}

// ---------------------------------------------------------------------------
// Process Lifecycle & Graceful Shutdown
// ---------------------------------------------------------------------------
const shutdown = (signal) => {
  console.log(`\n[bot] Received ${signal}. Terminating any running child processes...`);
  for (const [chatId, session] of chatSessions.entries()) {
    if (session.runningProcess) {
      console.log(`[bot] Killing active process for chat ${chatId}`);
      try {
        session.runningProcess.kill('SIGTERM');
      } catch {}
    }
  }
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Launch the bot
bot.launch().then(() => {
  console.log('🚀 Telegram Bot is online and listening for messages!');
}).catch((err) => {
  console.error('FATAL: Failed to launch Telegram Bot:', err);
  process.exit(1);
});
