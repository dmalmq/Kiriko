/**
 * Unit coverage for the serial GDAL process queue. Every test injects a
 * controllable fake worker (never the real gdal3.js worker thread — that path
 * is exercised only by the GDAL smoke) so we can drive the result / error /
 * exit / deadline / abort lifecycle deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GdalOperationError,
  resetSpawnWorkerForTests,
  runGdalOperation,
  setSpawnWorkerForTests,
  type GdalRequest,
  type GdalWorkerHandle,
  type GdalWorkerMessage,
} from "../src/gdb/gdalProcess";
import { GdbSourceError } from "../src/gdb/sourceValidation";

/** A hand-driven {@link GdalWorkerHandle}: the test emits its events by hand. */
class FakeWorker implements GdalWorkerHandle {
  readonly request: GdalRequest;
  terminated = false;
  private readonly msg: Array<(m: GdalWorkerMessage) => void> = [];
  private readonly err: Array<(e: Error) => void> = [];
  private readonly exit: Array<(code: number) => void> = [];
  /** Set by the queue-independent test wiring to react to a terminate() call. */
  onTerminate?: () => void;

  constructor(request: GdalRequest) {
    this.request = request;
  }

  onMessage(cb: (m: GdalWorkerMessage) => void): void {
    this.msg.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.err.push(cb);
  }
  onExit(cb: (code: number) => void): void {
    this.exit.push(cb);
  }
  terminate(): void {
    this.terminated = true;
    this.onTerminate?.();
  }

  emitMessage(m: GdalWorkerMessage): void {
    for (const cb of [...this.msg]) cb(m);
  }
  emitError(e: Error): void {
    for (const cb of [...this.err]) cb(e);
  }
  emitExit(code = 0): void {
    for (const cb of [...this.exit]) cb(code);
  }
}

const REQUEST: GdalRequest = { op: "inspect", path: "/tmp/x.gdb.zip", sourceName: "x" };

let spawned: FakeWorker[] = [];

/** Register a spawnWorker that records each spawned fake for the test to drive. */
function useRecordingSpawner(): void {
  spawned = [];
  setSpawnWorkerForTests((request) => {
    const worker = new FakeWorker(request);
    spawned.push(worker);
    return worker;
  });
}

/** Flush the microtask queue so queued `.then` continuations settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useRecordingSpawner();
});

afterEach(() => {
  resetSpawnWorkerForTests();
  vi.useRealTimers();
});

describe("runGdalOperation lifecycle", () => {
  it("(f) resolves with the posted result once the worker exits", async () => {
    const promise = runGdalOperation<number>(REQUEST, { deadlineMs: 10_000 });
    await flush();
    expect(spawned).toHaveLength(1);
    const worker = spawned[0]!;

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    worker.emitMessage({ ok: true, result: 42 });
    await flush();
    // A result message alone must NOT settle — staged-file safety requires exit.
    expect(settled).toBe(false);

    worker.emitExit(0);
    await expect(promise).resolves.toBe(42);
  });

  it("(e) rejects gdal_crashed when the worker exits without a result", async () => {
    const promise = runGdalOperation(REQUEST, { deadlineMs: 10_000 });
    await flush();
    const worker = spawned[0]!;

    worker.emitExit(1);
    await expect(promise).rejects.toMatchObject({ code: "gdal_crashed" });
    await expect(promise).rejects.toBeInstanceOf(GdalOperationError);
  });

  it("reconstructs a structured GdbSourceError posted by the worker", async () => {
    const promise = runGdalOperation(REQUEST, { deadlineMs: 10_000 });
    await flush();
    const worker = spawned[0]!;

    worker.emitMessage({
      ok: false,
      error: {
        name: "GdbSourceError",
        code: "missing_network_layers",
        message: "missing layers",
        details: { missing: ["net_path"] },
      },
    });
    worker.emitExit(0);

    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GdbSourceError);
    expect((error as GdbSourceError).code).toBe("missing_network_layers");
    expect((error as GdbSourceError).details).toEqual({ missing: ["net_path"] });
  });

  it("(b) terminates a deadline-exceeding op and awaits its exit before rejecting gdal_timeout", async () => {
    vi.useFakeTimers();
    const promise = runGdalOperation(REQUEST, { deadlineMs: 1_000 });
    const outcome = promise.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await flush();
    const worker = spawned[0]!;
    expect(worker.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    // Deadline fired: terminate requested, but exit not yet observed → pending.
    expect(worker.terminated).toBe(true);
    let done = false;
    void promise.catch(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);

    worker.emitExit(1);
    const result = await outcome;
    expect(result).toBeInstanceOf(GdalOperationError);
    expect((result as GdalOperationError).code).toBe("gdal_timeout");
  });

  it("(a) rejects a queued op whose deadline elapsed before it starts, never spawning it", async () => {
    vi.useFakeTimers();
    // Occupy the queue with a long op.
    const first = runGdalOperation<number>(REQUEST, { deadlineMs: 1_000_000 });
    await flush();
    expect(spawned).toHaveLength(1);

    // Queue a second op with a short deadline behind the still-running first.
    const second = runGdalOperation(REQUEST, { deadlineMs: 100 });
    const secondOutcome = second.then(
      () => "resolved",
      (e: unknown) => e,
    );

    // Let the second op's deadline elapse while the first still holds the queue.
    await vi.advanceTimersByTimeAsync(500);
    expect(spawned).toHaveLength(1); // second must not have spawned yet

    // Release the first op.
    spawned[0]!.emitMessage({ ok: true, result: 1 });
    spawned[0]!.emitExit(0);
    await expect(first).resolves.toBe(1);
    await flush();

    // The second op sees an already-elapsed deadline and rejects without spawning.
    const outcome = await secondOutcome;
    expect(outcome).toBeInstanceOf(GdalOperationError);
    expect((outcome as GdalOperationError).code).toBe("gdal_timeout");
    expect(spawned).toHaveLength(1);
  });

  it("(c) a hung worker does not block the next queued op beyond the deadline", async () => {
    vi.useFakeTimers();
    // The first worker hangs; auto-fire exit shortly after it is terminated.
    setSpawnWorkerForTests((request) => {
      const worker = new FakeWorker(request);
      spawned.push(worker);
      worker.onTerminate = () => {
        setTimeout(() => worker.emitExit(1), 5);
      };
      return worker;
    });
    spawned = [];

    const first = runGdalOperation(REQUEST, { deadlineMs: 1_000 });
    const firstOutcome = first.then(
      () => "resolved",
      (e: unknown) => e,
    );
    // The second op keeps a live budget; it should run once the first exits.
    const second = runGdalOperation<string>(REQUEST, { deadlineMs: 10_000 });
    await flush();
    expect(spawned).toHaveLength(1); // only the first has started

    await vi.advanceTimersByTimeAsync(1_000); // first deadline fires -> terminate
    await vi.advanceTimersByTimeAsync(5); // first exit -> first rejects, second starts
    await flush();

    const firstResult = await firstOutcome;
    expect(firstResult).toBeInstanceOf(GdalOperationError);
    expect((firstResult as GdalOperationError).code).toBe("gdal_timeout");

    expect(spawned).toHaveLength(2); // the second op ran only after the first exited
    spawned[1]!.emitMessage({ ok: true, result: "second" });
    spawned[1]!.emitExit(0);
    await expect(second).resolves.toBe("second");
  });

  it("(d) an abort signal terminates the worker and awaits exit before rejecting gdal_aborted", async () => {
    const controller = new AbortController();
    const promise = runGdalOperation(REQUEST, {
      deadlineMs: 10_000,
      signal: controller.signal,
    });
    const outcome = promise.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await flush();
    const worker = spawned[0]!;

    controller.abort();
    await flush();
    expect(worker.terminated).toBe(true);

    let done = false;
    void promise.catch(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false); // still awaiting exit

    worker.emitExit(1);
    const result = await outcome;
    expect(result).toBeInstanceOf(GdalOperationError);
    expect((result as GdalOperationError).code).toBe("gdal_aborted");
  });

  it("runs operations one at a time in FIFO order", async () => {
    const order: string[] = [];
    const first = runGdalOperation<number>(REQUEST, { deadlineMs: 10_000 });
    const second = runGdalOperation<number>(REQUEST, { deadlineMs: 10_000 });
    await flush();
    expect(spawned).toHaveLength(1); // second is queued behind first

    order.push("first:settle");
    spawned[0]!.emitMessage({ ok: true, result: 1 });
    spawned[0]!.emitExit(0);
    await expect(first).resolves.toBe(1);
    await flush();

    expect(spawned).toHaveLength(2);
    order.push("second:settle");
    spawned[1]!.emitMessage({ ok: true, result: 2 });
    spawned[1]!.emitExit(0);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:settle", "second:settle"]);
  });
});
