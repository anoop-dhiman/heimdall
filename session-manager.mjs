import fs from 'node:fs';
import path from 'node:path';

/**
 * SessionManager tracks and persists multi-turn Claude Code conversation sessions
 * across Telegram chats.
 */
export class SessionManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { chats: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(raw);
        if (!this.data.chats) this.data.chats = {};
      }
    } catch (err) {
      console.warn('[session-manager] Failed to load sessions, initializing fresh:', err.message);
      this.data = { chats: {} };
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[session-manager] Failed to save sessions:', err.message);
    }
  }

  sanitizeName(name) {
    if (!name) return '';
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32);
  }

  ensureChat(chatId) {
    const id = String(chatId);
    if (!this.data.chats[id]) {
      this.data.chats[id] = {
        activeSession: 'default',
        sessions: {
          default: {
            id: null,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          },
        },
      };
      this.save();
    }
    const chat = this.data.chats[id];
    if (!chat.sessions || Object.keys(chat.sessions).length === 0) {
      chat.sessions = {
        default: {
          id: null,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };
      chat.activeSession = 'default';
      this.save();
    }
    if (!chat.sessions[chat.activeSession]) {
      chat.activeSession = Object.keys(chat.sessions)[0];
      this.save();
    }
    return chat;
  }

  getActive(chatId) {
    const chat = this.ensureChat(chatId);
    return {
      name: chat.activeSession,
      ...chat.sessions[chat.activeSession],
    };
  }

  list(chatId) {
    const chat = this.ensureChat(chatId);
    return Object.entries(chat.sessions).map(([name, s]) => ({
      name,
      id: s.id || null,
      isActive: name === chat.activeSession,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    }));
  }

  switch(chatId, sessionName) {
    const chat = this.ensureChat(chatId);
    const sanitized = this.sanitizeName(sessionName);
    if (!chat.sessions[sanitized]) {
      return { success: false, error: `Session "${sanitized}" does not exist.` };
    }
    chat.activeSession = sanitized;
    chat.sessions[sanitized].lastActiveAt = new Date().toISOString();
    this.save();
    return { success: true, session: { name: sanitized, ...chat.sessions[sanitized] } };
  }

  create(chatId, sessionName) {
    const chat = this.ensureChat(chatId);
    let name = this.sanitizeName(sessionName);
    if (!name) {
      let counter = Object.keys(chat.sessions).length + 1;
      while (chat.sessions[`session-${counter}`]) {
        counter++;
      }
      name = `session-${counter}`;
    }

    if (chat.sessions[name]) {
      chat.activeSession = name;
      chat.sessions[name].lastActiveAt = new Date().toISOString();
      this.save();
      return { success: true, name, existed: true };
    }

    chat.sessions[name] = {
      id: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    chat.activeSession = name;
    this.save();
    return { success: true, name, existed: false };
  }

  delete(chatId, sessionName) {
    const chat = this.ensureChat(chatId);
    const sanitized = this.sanitizeName(sessionName);
    if (!chat.sessions[sanitized]) {
      return { success: false, error: `Session "${sanitized}" not found.` };
    }

    delete chat.sessions[sanitized];

    if (chat.activeSession === sanitized) {
      const remaining = Object.keys(chat.sessions);
      if (remaining.length > 0) {
        chat.activeSession = remaining[0];
      } else {
        chat.sessions.default = {
          id: null,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };
        chat.activeSession = 'default';
      }
    }
    this.save();
    return { success: true, activeSession: chat.activeSession };
  }

  updateClaudeId(chatId, sessionName, claudeSessionId) {
    const chat = this.ensureChat(chatId);
    if (chat.sessions[sessionName]) {
      chat.sessions[sessionName].id = claudeSessionId;
      chat.sessions[sessionName].lastActiveAt = new Date().toISOString();
      this.save();
    }
  }

  resetActiveContext(chatId) {
    const chat = this.ensureChat(chatId);
    if (chat.sessions[chat.activeSession]) {
      chat.sessions[chat.activeSession].id = null;
      chat.sessions[chat.activeSession].lastActiveAt = new Date().toISOString();
      this.save();
      return chat.activeSession;
    }
    return 'default';
  }
}
