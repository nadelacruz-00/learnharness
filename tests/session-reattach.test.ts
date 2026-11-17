/**
 * WAKE REATTACH (remote-server Phase 3): SessionModel.reattachIfNeeded, the
 * decision the session hook runs when the page becomes visible again, the
 * network comes back, or the page returns from the back/forward cache.
 *
 * - Busy (submitted/streaming) with a live stream: nothing to do. Bytes,
 *   heartbeats included, count as life.
 * - Busy with a dead stream (no bytes for streamStaleMs — a sleeping phone
 *   can leave reader.read() pending forever): refetch the record and replay
 *   the SAME server turn, aborting the dead consumer first.
 * - Idle (ready/error): reconcile; when the record says a turn is in flight
 *   (another device started it, or our recovery already failed), attach.
 * - Never two concurrent consumers; never a resend of the learner's input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel, STREAM_STALE_MS } from "../components/session-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const encoder = new TextEncoder();
const STREAM_DROPPED = "The connection dropped before the turn completed.";

function frame(event: unknown): string {
	return event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`;
}

const userMsg = { id: "u1", role: "user", content: "go", timestamp: 1 } as unknown as LhMessage;
function assistantMsg(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		timestamp: 2,
		provider: "openrouter",
		model: "test",
	} as unknown as LhMessage;
}
const started = { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } };
const finished = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop" } };

interface HeldStream {
	push(text: string): void;
	close(): void;
	signal: AbortSignal | undefined;
}

/** A fake server: the record (GET /api/chats/chat_x) and held-open turn
 *  streams (GET .../stream) the test drives by hand. An aborted fetch
 *  errors its body, the way a browser does. */
function server() {
	const state = {
		calls: [] as string[],
		streams: [] as HeldStream[],
		record: { messages: [userMsg] as LhMessage[], turnInFlight: false },
		/** When set, record reads wait for this promise. */
		holdRecord: null as Promise<void> | null,
		clock: 1_000_000,
	};
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		state.calls.push(url);
		if (url === "/api/chat") throw new Error("reattach must never resend input");
		if (url === "/api/chats/chat_x") {
			if (state.holdRecord) await state.holdRecord;
			return Response.json({ messages: state.record.messages, turnInFlight: state.record.turnInFlight });
		}
		if (url === "/api/chats/chat_x/stream") {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
			init?.signal?.addEventListener("abort", () => {
				try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* closed */ }
			}, { once: true });
			state.streams.push({
				push: (text) => controller.enqueue(encoder.encode(text)),
				close: () => controller.close(),
				signal: init?.signal ?? undefined,
			});
			return new Response(body);
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	const model = new SessionModel({ chatId: "chat_x", initialMessages: [userMsg], fetch, now: () => state.clock });
	const streamCalls = () => state.calls.filter((url) => url.endsWith("/stream")).length;
	const recordCalls = () => state.calls.filter((url) => url === "/api/chats/chat_x").length;
	return { state, model, streamCalls, recordCalls };
}

/** Let the model's promise chains run until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${what}`);
}

/** Finish the turn on the newest stream; the terminal read returns the saved answer. */
async function finishTurn(s: ReturnType<typeof server>): Promise<void> {
	s.state.record = { messages: [userMsg, assistantMsg("a1", "complete")], turnInFlight: false };
	const stream = s.state.streams.at(-1)!;
	stream.push(frame({ type: "agent_start" }) + frame(started) + frame(finished) + frame("[DONE]"));
	stream.close();
	await until(() => s.model.status === "ready", "the turn to settle");
}

describe("reattachIfNeeded while a turn streams here", () => {
	it("leaves a live stream alone; heartbeat bytes count as life", async () => {
		const s = server();
		void s.model.resumeStream(false);
		await until(() => s.state.streams.length === 1, "the first stream");
		s.state.streams[0]!.push(frame({ type: "agent_start" }) + frame(started));
		await until(() => s.model.status === "streaming", "streaming");

		s.state.clock += 10_000;
		assert.equal(await s.model.reattachIfNeeded(), false);
		s.state.clock += 30_000;
		s.state.streams[0]!.push(": ping\n\n");
		await new Promise((resolve) => setImmediate(resolve));
		s.state.clock += STREAM_STALE_MS - 1;
		assert.equal(await s.model.reattachIfNeeded(), false, "a ping within the window keeps the stream");
		assert.equal(s.streamCalls(), 1);
		assert.equal(s.state.streams[0]!.signal?.aborted, false);

		await finishTurn(s);
		assert.equal(s.streamCalls(), 1);
	});

	it("replaces a stalled stream: aborts it, refetches the record, replays the same turn once", async () => {
		const s = server();
		void s.model.resumeStream(false);
		await until(() => s.state.streams.length === 1, "the first stream");
		s.state.streams[0]!.push(frame({ type: "agent_start" }) + frame(started));
		await until(() => s.model.status === "streaming", "streaming");
		s.state.record = { messages: [userMsg], turnInFlight: true };
		const recordsBefore = s.recordCalls();

		s.state.clock += STREAM_STALE_MS; // the phone slept; read() still pending
		assert.equal(await s.model.reattachIfNeeded(), true);
		assert.equal(s.state.streams[0]!.signal?.aborted, true, "the dead consumer is aborted first");
		await until(() => s.state.streams.length === 2, "the replacement stream");
		assert.equal(s.recordCalls(), recordsBefore + 1, "record refetch before the replay");
		const replay = s.state.calls.lastIndexOf("/api/chats/chat_x/stream");
		assert.equal(s.state.calls[replay - 1], "/api/chats/chat_x", "the record read lands just before the replay stream");

		// A second wake right after: the fresh consumer is alive.
		assert.equal(await s.model.reattachIfNeeded(), false);
		assert.equal(s.streamCalls(), 2);

		await finishTurn(s);
		assert.equal(s.model.getState().error, null);
		const assistants = s.model.getState().nativeMessages.filter((m) => m.role === "assistant");
		assert.equal(assistants.length, 1, "the replay never doubles the answer");
		assert.equal(s.model.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});

	it("concurrent wake events share one decision and open one stream", async () => {
		const s = server();
		void s.model.resumeStream(false);
		await until(() => s.state.streams.length === 1, "the first stream");
		s.state.streams[0]!.push(frame({ type: "agent_start" }) + frame(started));
		await until(() => s.model.status === "streaming", "streaming");
		s.state.clock += STREAM_STALE_MS * 3;
		const [a, b, c] = await Promise.all([s.model.reattachIfNeeded(), s.model.reattachIfNeeded(), s.model.reattachIfNeeded()]);
		assert.deepEqual([a, b, c], [true, true, true]);
		await until(() => s.state.streams.length === 2, "the replacement stream");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(s.streamCalls(), 2);
		await finishTurn(s);
	});
});

describe("reattachIfNeeded while idle", () => {
	it("attaches to a turn another device started", async () => {
		const s = server();
		s.state.record = { messages: [userMsg], turnInFlight: true };
		assert.equal(s.model.status, "ready");
		assert.equal(await s.model.reattachIfNeeded(), true);
		await until(() => s.state.streams.length === 1, "the attach stream");
		assert.equal(s.state.calls[0], "/api/chats/chat_x", "reconcile first");
		await finishTurn(s);
		assert.equal(s.model.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});

	it("only adopts the record when no turn runs (an answer that finished while the phone slept)", async () => {
		const s = server();
		s.state.record = { messages: [userMsg, assistantMsg("a1", "done elsewhere")], turnInFlight: false };
		assert.equal(await s.model.reattachIfNeeded(), false);
		assert.equal(s.streamCalls(), 0);
		assert.equal(s.model.status, "ready");
		assert.equal(s.model.getState().reconciliation, "ready");
		assert.equal(s.model.getState().messages.at(-1)!.parts.at(-1)!.text, "done elsewhere");
	});

	it("recovers after the one automatic recovery failed (error state), and clears the drop banner", async () => {
		const s = server();
		void s.model.resumeStream(false);
		await until(() => s.state.streams.length === 1, "the first stream");
		s.state.streams[0]!.push(frame({ type: "agent_start" }) + frame(started));
		s.state.streams[0]!.close(); // EOF without [DONE]
		await until(() => s.state.streams.length === 2, "the automatic recovery");
		s.state.streams[1]!.close(); // drops again
		await until(() => s.model.status === "error", "the error state");
		assert.equal(s.model.getState().error?.message, STREAM_DROPPED);

		s.state.record = { messages: [userMsg], turnInFlight: true };
		assert.equal(await s.model.reattachIfNeeded(), true);
		await until(() => s.state.streams.length === 3, "the wake reattach");
		await finishTurn(s);
		assert.equal(s.model.getState().error, null);
	});

	it("does not attach when the view stopped during the record read", async () => {
		const s = server();
		s.state.record = { messages: [userMsg], turnInFlight: true };
		let release!: () => void;
		s.state.holdRecord = new Promise<void>((resolve) => { release = resolve; });
		const decision = s.model.reattachIfNeeded();
		await until(() => s.recordCalls() === 1, "the record read");
		s.model.stop(); // navigated away (unmount)
		release();
		assert.equal(await decision, false);
		assert.equal(s.streamCalls(), 0);
	});

	it("does not attach when the record read fails (offline), and a later wake can", async () => {
		const s = server();
		s.state.record = { messages: [userMsg], turnInFlight: true };
		let offline = true;
		const inner = s.model.fetch;
		s.model.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (offline) throw new TypeError("synthetic offline");
			return inner(input, init);
		}) as typeof globalThis.fetch;
		assert.equal(await s.model.reattachIfNeeded(), false);
		assert.equal(s.streamCalls(), 0);
		offline = false;
		assert.equal(await s.model.reattachIfNeeded(), true);
		await until(() => s.state.streams.length === 1, "the attach stream");
		await finishTurn(s);
	});
});
