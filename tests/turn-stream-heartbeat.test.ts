/**
 * TURN STREAM HEARTBEAT (remote-server Phase 3): Cloudflare closes an HTTP
 * connection that sends no bytes for about 100 s, and a long tool call or a
 * slow model can be silent for longer. piTurnResponse wraps the subscriber
 * stream so that a `: ping` SSE comment goes out every TURN_HEARTBEAT_MS
 * while the turn is live. The timer must stop when the turn settles (the
 * source closes) and when the view leaves (the reader cancels), and the
 * client parser (sseEvents) must skip the comment frames.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { piTurnResponse, TURN_HEARTBEAT_MS, withHeartbeat, type PiTurnHandle } from "../src/server/pi/ui-stream.ts";
import { sseEvents } from "../components/session-core.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A subscriber-shaped source the test drives by hand. */
function controlledSource(): {
	stream: ReadableStream<Uint8Array>;
	push(text: string): void;
	close(): void;
	cancelled: unknown[];
} {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancelled: unknown[] = [];
	const stream = new ReadableStream<Uint8Array>({
		start(c) { controller = c; },
		cancel(reason) { cancelled.push(reason); },
	});
	return {
		stream,
		push: (text) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
		cancelled,
	};
}

/** Count the heartbeat timers started and cleared (mock.timers replaces the
 *  globals; withHeartbeat looks them up at call time). */
let started = 0;
let cleared = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
beforeEach(() => {
	mock.timers.enable({ apis: ["setInterval"] });
	started = 0;
	cleared = 0;
	const mockedSet = globalThis.setInterval;
	const mockedClear = globalThis.clearInterval;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { started++; return mockedSet(...args); }) as typeof setInterval;
	globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => { cleared++; mockedClear(id); }) as typeof clearInterval;
});
afterEach(() => {
	mock.timers.reset();
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
});

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
	const { done, value } = await reader.read();
	return done ? null : decoder.decode(value);
}

describe("withHeartbeat (the SSE keepalive)", () => {
	it("pings every TURN_HEARTBEAT_MS (20 s) while the turn is silent", async () => {
		assert.equal(TURN_HEARTBEAT_MS, 20_000);
		const source = controlledSource();
		const reader = withHeartbeat(source.stream).getReader();
		assert.equal(started, 1);
		const first = reader.read();
		mock.timers.tick(19_999);
		let settledEarly = false;
		void first.then(() => { settledEarly = true; });
		await Promise.resolve();
		assert.equal(settledEarly, false, "no ping before the interval");
		mock.timers.tick(1);
		const ping = await first;
		assert.equal(decoder.decode(ping.value), ": ping\n\n");
		const second = reader.read();
		mock.timers.tick(20_000);
		assert.equal(decoder.decode((await second).value), ": ping\n\n");
		await reader.cancel();
	});

	it("passes turn frames through unchanged, interleaved with pings at frame boundaries", async () => {
		const source = controlledSource();
		const reader = withHeartbeat(source.stream).getReader();
		source.push(`data: ${JSON.stringify({ type: "agent_start" })}\n\n`);
		assert.equal(await readText(reader), 'data: {"type":"agent_start"}\n\n');
		const pending = reader.read();
		mock.timers.tick(20_000);
		assert.equal(decoder.decode((await pending).value), ": ping\n\n");
		source.push("data: [DONE]\n\n");
		assert.equal(await readText(reader), "data: [DONE]\n\n");
		await reader.cancel();
	});

	it("does not pile pings into the queue while bytes already wait for the reader", async () => {
		const source = controlledSource();
		const reader = withHeartbeat(source.stream).getReader();
		mock.timers.tick(20_000); // queue: one ping (high-water mark reached)
		mock.timers.tick(20_000); // skipped: the queued ping already keeps the line busy
		mock.timers.tick(20_000);
		assert.equal(await readText(reader), ": ping\n\n");
		source.push("data: [DONE]\n\n");
		source.close();
		assert.equal(await readText(reader), "data: [DONE]\n\n");
		assert.equal(await readText(reader), null);
	});

	it("stops the timer when the turn settles (the source closes)", async () => {
		const source = controlledSource();
		const reader = withHeartbeat(source.stream).getReader();
		source.push("data: [DONE]\n\n");
		source.close();
		assert.equal(await readText(reader), "data: [DONE]\n\n");
		assert.equal(await readText(reader), null);
		assert.equal(cleared, 1);
		mock.timers.tick(TURN_HEARTBEAT_MS * 5); // a leaked interval would enqueue into a closed stream
		assert.equal(cleared, 1);
	});

	it("stops the timer and detaches the source when the view leaves (cancel)", async () => {
		const source = controlledSource();
		const reader = withHeartbeat(source.stream).getReader();
		await reader.cancel("view left");
		assert.equal(cleared, 1);
		assert.deepEqual(source.cancelled, ["view left"]);
	});

	it("stops the timer when the source errors", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const reader = withHeartbeat(new ReadableStream<Uint8Array>({ start(c) { controller = c; } })).getReader();
		controller.error(new Error("synthetic source failure"));
		await assert.rejects(reader.read(), /synthetic source failure/);
		assert.equal(cleared, 1);
	});
});

describe("piTurnResponse", () => {
	it("sends SSE headers that stop proxy buffering and transforms, and heartbeats the body", async () => {
		const source = controlledSource();
		const handle: PiTurnHandle = { subscribe: () => source.stream, abort() {} };
		const res = piTurnResponse(handle);
		assert.equal(res.headers.get("content-type"), "text/event-stream");
		assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
		assert.equal(res.headers.get("x-accel-buffering"), "no");
		const reader = res.body!.getReader();
		const pending = reader.read();
		mock.timers.tick(TURN_HEARTBEAT_MS);
		assert.equal(decoder.decode((await pending).value), ": ping\n\n");
		await reader.cancel();
		assert.equal(source.cancelled.length, 1, "cancel reaches the subscriber (the view detaches)");
	});
});

describe("sseEvents (client parser)", () => {
	it("skips `: ping` comment frames, even split across reads, and reports every read as activity", async () => {
		const wire = `: ping\n\ndata: {"type":"agent_start"}\n\n: ping\n\ndata: [DONE]\n\n`;
		const bytes = encoder.encode(wire);
		const reader = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
				controller.close();
			},
		}).getReader();
		let activity = 0;
		const events = sseEvents(reader, () => { activity++; });
		const seen: unknown[] = [];
		let next = await events.next();
		while (!next.done) { seen.push(next.value); next = await events.next(); }
		assert.deepEqual(seen, [{ type: "agent_start" }]);
		assert.equal(next.value, true, "[DONE] still ends the stream");
		assert.equal(activity, Math.ceil(bytes.length / 5));
	});
});
