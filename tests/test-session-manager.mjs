import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../session-manager.mjs';

console.log('🧪 Running Heimdall Session Manager Test Suite...\n');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-test-'));
const testDbPath = path.join(tempDir, 'sessions.json');

try {
  const sm = new SessionManager(testDbPath);
  const chatId = 123456;

  // 1. Initial chat state has default session
  const initial = sm.getActive(chatId);
  assert.strictEqual(initial.name, 'default');
  assert.strictEqual(initial.id, null);
  console.log('✅ Test 1: Initial chat created with "default" session');

  // 2. Update Claude ID
  sm.updateClaudeId(chatId, 'default', 'uuid-default-123');
  assert.strictEqual(sm.getActive(chatId).id, 'uuid-default-123');
  console.log('✅ Test 2: Claude session ID updated and saved');

  // 3. Create a new session 'k8s-debug'
  const resNew = sm.create(chatId, 'k8s-debug');
  assert.strictEqual(resNew.success, true);
  assert.strictEqual(resNew.name, 'k8s-debug');
  assert.strictEqual(sm.getActive(chatId).name, 'k8s-debug');
  assert.strictEqual(sm.getActive(chatId).id, null);
  console.log('✅ Test 3: New session "k8s-debug" created and set as active');

  // 4. Update Claude ID for 'k8s-debug'
  sm.updateClaudeId(chatId, 'k8s-debug', 'uuid-k8s-456');
  assert.strictEqual(sm.getActive(chatId).id, 'uuid-k8s-456');
  console.log('✅ Test 4: Updated Claude ID for "k8s-debug"');

  // 5. Switch back to 'default'
  const resSwitch = sm.switch(chatId, 'default');
  assert.strictEqual(resSwitch.success, true);
  assert.strictEqual(sm.getActive(chatId).name, 'default');
  assert.strictEqual(sm.getActive(chatId).id, 'uuid-default-123');
  console.log('✅ Test 5: Switched back to "default", preserving its Claude ID');

  // 6. List sessions
  const list = sm.list(chatId);
  assert.strictEqual(list.length, 2);
  const activeItem = list.find((i) => i.isActive);
  assert.strictEqual(activeItem.name, 'default');
  console.log('✅ Test 6: Listed all sessions with active indicator');

  // 7. Auto-named session creation
  const resAuto = sm.create(chatId, '');
  assert.strictEqual(resAuto.success, true);
  assert.ok(resAuto.name.startsWith('session-'));
  console.log(`✅ Test 7: Auto-named session "${resAuto.name}" created`);

  // 8. Delete session
  const resDel = sm.delete(chatId, resAuto.name);
  assert.strictEqual(resDel.success, true);
  assert.strictEqual(sm.list(chatId).length, 2);
  console.log(`✅ Test 8: Session "${resAuto.name}" deleted`);

  // 9. Persistence check: Reload from file
  const smReloaded = new SessionManager(testDbPath);
  const activeReloaded = smReloaded.getActive(chatId);
  assert.strictEqual(activeReloaded.name, 'default');
  assert.strictEqual(activeReloaded.id, 'uuid-default-123');
  assert.strictEqual(smReloaded.list(chatId).length, 2);
  console.log('✅ Test 9: Sessions accurately reloaded from disk persistence');

  // 10. Reset active context
  const resetName = smReloaded.resetActiveContext(chatId);
  assert.strictEqual(resetName, 'default');
  assert.strictEqual(smReloaded.getActive(chatId).id, null);
  console.log('✅ Test 10: Active session context reset without deleting session entry');

  console.log('\n🎉 All 10 Session Manager tests passed with 100% success!');
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}
