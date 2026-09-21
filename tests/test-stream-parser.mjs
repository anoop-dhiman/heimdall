import assert from 'node:assert';
import { EventEmitter } from 'node:events';

console.log('🧪 Running Heimdall Stream Parser Test Suite...\n');

// ---------------------------------------------------------------------------
// Extracted parser logic matching bot.mjs
// ---------------------------------------------------------------------------
function parseClaudeStreamEvents(lines) {
  let finalResultText = '';
  let latestAssistantText = '';
  const allAssistantTexts = [];
  let streamedText = '';
  let nonJsonOutput = '';
  let detectedSessionId = null;
  const toolCalls = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);

      // Session ID
      if (event.session_id) detectedSessionId = event.session_id;
      else if (event.sessionId) detectedSessionId = event.sessionId;
      else if (event.session?.id) detectedSessionId = event.session.id;

      // 1. Tool use
      if (event.type === 'tool_use' || event.type === 'tool_call') {
        toolCalls.push({ name: event.name || event.tool || 'Tool', input: event.input });
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolCalls.push({ name: event.content_block.name || 'Tool', input: event.content_block.input });
      }

      // 2. Assistant message events
      if (event.type === 'assistant' && event.message?.content) {
        let turnText = '';
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            turnText += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name || 'Tool', input: block.input });
          }
        }
        if (turnText.trim()) {
          latestAssistantText = turnText.trim();
          allAssistantTexts.push(turnText.trim());
        }
      }

      // 3. Direct content arrays
      if (Array.isArray(event.content)) {
        let blockText = '';
        for (const block of event.content) {
          if (block.type === 'text' && block.text) {
            blockText += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name || 'Tool', input: block.input });
          }
        }
        if (blockText.trim()) {
          latestAssistantText = blockText.trim();
          allAssistantTexts.push(blockText.trim());
        }
      }

      // 4. Streaming deltas
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

      // 5. Final result event
      if (event.type === 'result') {
        if (typeof event.result === 'string' && event.result.trim()) {
          finalResultText = event.result.trim();
        } else if (event.result?.text && typeof event.result.text === 'string') {
          finalResultText = event.result.text.trim();
        }
        if (event.session_id) detectedSessionId = event.session_id;
      }
    } catch {
      nonJsonOutput += trimmed + '\n';
    }
  }

  // Priority selection
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

  return { outputText, toolCalls, detectedSessionId };
}

// ---------------------------------------------------------------------------
// Test 1: Multi-turn tool run with empty terminal result (The User's Exact Bug)
// ---------------------------------------------------------------------------
{
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc-123" }),
    // Turn 1: Claude runs kubectl get pods
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Checking pods for sandbox jb_9618956781..." },
          { type: "tool_use", name: "Bash", input: { command: "kubectl get pods -n jio-concierge" } }
        ]
      }
    }),
    // Turn 2: Claude inspects logs
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "kubectl logs sandbox-jb-9618956781" } }
        ]
      }
    }),
    // Turn 3: Claude delivers final diagnosis
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Latest message sent by user: 'Hello, what is my account balance?'. Agent responded with: 'Your current balance is 500 JioCoins.'" }
        ]
      }
    }),
    // Terminal event has empty result!
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-abc-123",
      result: ""
    })
  ];

  const res = parseClaudeStreamEvents(lines);
  assert.strictEqual(
    res.outputText,
    "Latest message sent by user: 'Hello, what is my account balance?'. Agent responded with: 'Your current balance is 500 JioCoins.'"
  );
  assert.strictEqual(res.toolCalls.length, 2);
  assert.strictEqual(res.toolCalls[0].name, "Bash");
  assert.strictEqual(res.detectedSessionId, "sess-abc-123");
  console.log("✅ Test 1 Passed: Multi-turn tool run extracts final assistant response when result is empty");
}

// ---------------------------------------------------------------------------
// Test 2: Direct one-shot response via result event
// ---------------------------------------------------------------------------
{
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-def-456" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-def-456",
      result: "All 5 cluster nodes are Ready."
    })
  ];

  const res = parseClaudeStreamEvents(lines);
  assert.strictEqual(res.outputText, "All 5 cluster nodes are Ready.");
  assert.strictEqual(res.detectedSessionId, "sess-def-456");
  console.log("✅ Test 2 Passed: Direct result event captured correctly");
}

// ---------------------------------------------------------------------------
// Test 3: Streaming token deltas
// ---------------------------------------------------------------------------
{
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-ghi-789" }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "Pod " } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "is " } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: "running." } } }),
  ];

  const res = parseClaudeStreamEvents(lines);
  assert.strictEqual(res.outputText, "Pod is running.");
  console.log("✅ Test 3 Passed: Streaming token deltas reconstructed");
}

// ---------------------------------------------------------------------------
// Test 4: Non-JSON error lines fallback
// ---------------------------------------------------------------------------
{
  const lines = [
    "Error: Cannot connect to Docker daemon socket at /var/run/docker.sock",
    "Is docker running?"
  ];

  const res = parseClaudeStreamEvents(lines);
  assert.ok(res.outputText.includes("Cannot connect to Docker daemon"));
  console.log("✅ Test 4 Passed: Non-JSON error lines captured as fallback text");
}

console.log("\n🎉 All 4 parser tests passed with 100% success!");
