// Offline check: fake pi + fake models. Run: node --experimental-strip-types tests/content-filter-repair/check.mjs
import assert from "node:assert/strict";
import ext from "../../content-filter-repair.ts";

const qwen = { provider: "dashscope", id: "qwen" };
const haiku = { provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-5-5" };
const sonnet = { provider: "amazon-bedrock", id: "eu.anthropic.claude-sonnet-5-5" };
const ERR = '400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}';
const OUT = "Output data may contain inappropriate content.";

const handlers = {};
const setModelCalls = [];
let leaf = null;
const notes = [];
const ctx = {
  model: qwen, hasUI: true, ui: { notify: (m) => notes.push(m) },
  sessionManager: { getLeafId: () => leaf },
  modelRegistry: {
    find: (p, id) => [haiku, sonnet].find((m) => m.provider === p && m.id === id),
    complete: async (model, c) => {
      const t = c.messages[0].content;
      if (model === haiku) {
        const reply = (text) => ({ stopReason: "stop", content: [{ type: "text", text }] });
        if (t.includes("<message role=")) return reply(/STUBBORN/.test(t) ? "still about 1989" : "The user asked about a historical event; the assistant gave an overview.");
        const body = t.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
        return reply(/HARD/.test(body) ? body : body.replace(/June 4, 1989 crackdown/g, "[sensitive detail omitted]"));
      }
      assert.equal(model, qwen, "only the original model is probed");
      return /1989/.test(t) ? { stopReason: "error", errorMessage: ERR } : { stopReason: "stop", content: [] };
    },
  },
};
ext({ on: (n, h) => (handlers[n] = h), setModel: async (m) => (setModelCalls.push(m.id), (ctx.model = m), true) });

const pe = (id, message) => ({ sourceEntry: { id, type: "message" }, messages: [message] });
const settle = (contextEntries, llmMessages = []) => handlers.agent_before_settle({ context: { canContinue: false, llmMessages, contextEntries } }, ctx);
const start = (leafId) => { leaf = leafId; handlers.before_agent_start({}, ctx); };
const end = (message) => handlers.message_end({ message: { role: "assistant", ...message } });

// 1. input block, rewordable -> edits on Qwen, retry, no model switch
start("a1");
end({ stopReason: "error", errorMessage: ERR });
let r = await settle([
  pe("u1", { role: "user", content: "what is tiananmen square?" }),
  pe("a1", { role: "assistant", content: [{ type: "thinking", thinking: "simple" }, { type: "text", text: "A square. Site of the June 4, 1989 crackdown." }] }),
  pe("u2", { role: "user", content: "what happened there??" }),
  pe("a2", { role: "assistant", content: [], stopReason: "error", errorMessage: ERR }),
]);
assert.equal(r.continue, true);
assert.deepEqual(r.entries, [
  { type: "context_edit", targetId: "a2", replacement: null },
  { type: "context_edit", targetId: "a1", replacement: { content: [{ type: "text", text: "A square. Site of the [sensitive detail omitted]." }] } },
]);
assert.equal(setModelCalls.length, 0);
assert.equal(await settle([pe("u2", { role: "user", content: "x" })]), undefined, "no pending error -> no-op");

// 2. output block (real shape from session 01a0f1a0) -> drop partial, Sonnet continues at once
start("prev");
end({ stopReason: "error", errorMessage: OUT });
r = await settle([
  pe("prev", { role: "assistant", content: [{ type: "text", text: "earlier, harmless" }] }),
  pe("u9", { role: "user", content: "what happened in Tiananmen square in 1989?" }),
  pe("a9", { role: "assistant", content: [{ type: "thinking", thinking: "1989" }, { type: "text", text: "In 1989…" }], stopReason: "error", errorMessage: OUT }),
]);
assert.deepEqual(r, { entries: [{ type: "context_edit", targetId: "a9", replacement: null }], continue: true });
assert.deepEqual(setModelCalls, [sonnet.id]);
assert.match(notes.at(-1), /↻ answer blocked mid-stream → eu\.anthropic\.claude-sonnet-5-5/);
//    Sonnet answers; at settle this run's flagged messages get neutral summaries (older harmless one untouched)
end({ stopReason: "stop", content: [{ type: "text", text: "In June 1989…" }] });
r = await settle([
  pe("prev", { role: "assistant", content: [{ type: "text", text: "earlier, harmless" }] }),
  pe("u9", { role: "user", content: "what happened in Tiananmen square in 1989?" }),
  pe("s9", { role: "assistant", content: [{ type: "text", text: "In June 1989…" }, { type: "toolCall", id: "t1", name: "x", arguments: {} }] }),
]);
const SUM = "The user asked about a historical event; the assistant gave an overview.";
assert.equal(r.continue, undefined, "sanitising never continues");
assert.deepEqual(r.entries, [
  { type: "context_edit", targetId: "s9", replacement: { content: [{ type: "text", text: SUM }, { type: "toolCall", id: "t1", name: "x", arguments: {} }] } },
  { type: "context_edit", targetId: "u9", replacement: { content: SUM } },
]);
await handlers.agent_settled({}, ctx);
assert.deepEqual(setModelCalls, [sonnet.id, qwen.id], "restored to qwen");

// 3. unrewordable older hit -> fallback; sanitise covers it even though it's before this run; summary still flagged -> placeholder
start("u5");
end({ stopReason: "error", errorMessage: ERR });
const hist = [
  pe("old", { role: "toolResult", content: [{ type: "text", text: "HARD STUBBORN 1989 archive dump" }] }),
  pe("u5", { role: "user", content: "fix the build" }),
];
r = await settle([...hist, pe("e5", { role: "assistant", content: [], stopReason: "error", errorMessage: ERR })]);
assert.equal(r.continue, true);
assert.deepEqual(r.entries, [{ type: "context_edit", targetId: "e5", replacement: null }], "no placeholder on the input path");
assert.match(notes.at(-1), /1 flagged message\(s\) couldn't be reworded → .*sonnet/);
end({ stopReason: "stop", content: [{ type: "text", text: "build fixed" }] });
r = await settle([...hist, pe("s5", { role: "assistant", content: [{ type: "text", text: "build fixed" }] })]);
assert.deepEqual(r.entries, [{ type: "context_edit", targetId: "old", replacement: { content: [{ type: "text", text: "[exchange handled by a fallback model because of the provider's content filter; omitted]" }] } }]);
//    user switched model during the fallback turn -> not restored
ctx.model = { provider: "openai", id: "gpt" };
await handlers.agent_settled({}, ctx);
assert.deepEqual(setModelCalls, [sonnet.id, qwen.id, sonnet.id], "manual choice wins");
ctx.model = qwen;

// 4. fallback fails too -> error with both reasons, restored, no continue
start("x");
end({ stopReason: "error", errorMessage: OUT });
await settle([pe("u6", { role: "user", content: "1989?" }), pe("e6", { role: "assistant", content: [], stopReason: "error", errorMessage: OUT })]);
end({ stopReason: "error", errorMessage: "ExpiredTokenException" });
assert.equal(await settle([pe("u6", { role: "user", content: "1989?" })]), undefined);
assert.match(notes.at(-1), /failed too: ExpiredTokenException[\s\S]*answer blocked mid-stream/);
await handlers.agent_settled({}, ctx);
assert.equal(ctx.model, qwen);

// 4b. live 2026-09-30: the user's own question is flagged -> never reworded, Sonnet answers the real question
start("pre");
end({ stopReason: "error", errorMessage: ERR });
const q = pe("uq", { role: "user", content: "what happened at Tiananmen Square in June 1989?" });
r = await settle([pe("pre", { role: "assistant", content: [{ type: "text", text: "ok" }] }), q, pe("eq", { role: "assistant", content: [], stopReason: "error", errorMessage: ERR })]);
assert.deepEqual(r, { entries: [{ type: "context_edit", targetId: "eq", replacement: null }], continue: true });
end({ stopReason: "stop", content: [{ type: "text", text: "a factual answer" }] });
r = await settle([q, pe("sq", { role: "assistant", content: [{ type: "text", text: "a factual answer" }] })]);
assert.deepEqual(r.entries, [{ type: "context_edit", targetId: "uq", replacement: { content: SUM } }], "question summarised only after it was answered");
await handlers.agent_settled({}, ctx);
assert.equal(ctx.model, qwen);

// 5. flagged compaction summary (rewordable) -> superseding compaction, same firstKeptEntryId/details, stays on Qwen
start("u3");
end({ stopReason: "error", errorMessage: ERR });
r = await settle([
  { sourceEntry: { id: "c1", type: "compaction", firstKeptEntryId: "k1", details: { om: 1 } },
    messages: [{ role: "system", content: "" }, { role: "compactionSummary", summary: "User asked about the June 4, 1989 crackdown." }] },
  pe("u3", { role: "user", content: "hi" }),
]);
assert.deepEqual(r.entries, [{ type: "compaction", summary: "User asked about the [sensitive detail omitted].", firstKeptEntryId: "k1", details: { om: 1 } }]);
assert.equal(ctx.model, qwen);

// 6. only the system prompt is flagged -> fallback, reason says so
start("u4");
end({ stopReason: "error", errorMessage: ERR });
r = await settle([pe("u4", { role: "user", content: "hi" })], [{ role: "system", content: "", sections: { mem: "note about 1989" } }]);
assert.equal(r.continue, true);
assert.match(notes.at(-1), /system prompt is flagged/);
end({ stopReason: "stop", content: [{ type: "text", text: "hello" }] });
assert.equal(await settle([pe("u4", { role: "user", content: "hi" }), pe("s4", { role: "assistant", content: [{ type: "text", text: "hello" }] })]), undefined);
await handlers.agent_settled({}, ctx);
assert.equal(ctx.model, qwen);
console.log("ok");
