/**
 * Serial, cancellable GDAL process queue.
 *
 * gdal3.js runs an Emscripten/WASM build of GDAL in-process; its virtual
 * filesystem and fixed `/output` namespace are single-tenant, so overlapping
 * operations corrupt each other. Worse, a runaway GDAL call cannot be
 * interrupted from the same thread — only destroying a separate worker
 * reclaims it. This module therefore runs **one GDAL operation at a time**,
 * each inside its **own** worker thread, and can truly terminate a
 * timed-out/aborted operation by killing that worker.
 *
 * Staged-file safety (the contract the routes rely on): the promise returned
 * by {@link runGdalOperation} settles **only after the worker has exited** —
 * on success, crash, or the post-terminate exit that follows a deadline/abort.
 * A result message alone never settles the promise; we stash it and wait for
 * the `exit` event. Because the queue's tail chains on that settle, the next
 * queued operation starts only after the current worker is gone. A route may
 * therefore delete its staged `.gdb.zip` in a `finally` after awaiting this
 * promise, certain that no live worker still holds the file.
 */
import { Worker } from "node:worker_threads";
import { GdbSourceError } from "./sourceValidation";

/** Per-op request dispatched to the worker; the `op` selects the GDAL body. */
export type GdalRequest =
  | { op: "inspect"; path: string; sourceName: string }
  | { op: "convert"; path: string; selectedLayerNames: readonly string[] }
  | { op: "network"; path: string }
  | { op: "facilities"; path: string }
  | { op: "export"; junctionsGeoJson: string; pathsGeoJson: string };

/** Structured message the worker posts back before it exits. */
export type GdalWorkerMessage =
  | { ok: true; result: unknown }
  | { ok: false; error: SerializedError };

/** Plain, structured-clonable error shape carried across the worker boundary. */
export interface SerializedError {
  name?: string;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * The minimal worker surface the queue drives. The real handle wraps a
 * `node:worker_threads` Worker; tests inject a hand-driven fake.
 */
export interface GdalWorkerHandle {
  onMessage(cb: (message: GdalWorkerMessage) => void): void;
  onError(cb: (error: Error) => void): void;
  onExit(cb: (code: number) => void): void;
  terminate(): void;
}

export type SpawnWorker = (request: GdalRequest) => GdalWorkerHandle;

export interface RunOptions {
  /** Wall-clock budget from enqueue. A queued op past it never spawns. */
  deadlineMs: number;
  /** Optional external cancellation. Abort terminates the worker. */
  signal?: AbortSignal;
}

/** Structured failure for queue-owned outcomes (never a GDAL op error). */
export class GdalOperationError extends Error {
  constructor(
    readonly code: "gdal_timeout" | "gdal_aborted" | "gdal_crashed",
    message: string,
  ) {
    super(message);
    this.name = "GdalOperationError";
  }
}

/** Default per-op deadline: the historical 60s inspect budget. */
export const GDAL_DEADLINE_MS = 60_000;

let deadlineOverride: number | null = null;

/** The deadline the GDB request builders pass to {@link runGdalOperation}. */
export function gdalDeadlineMs(): number {
  return deadlineOverride ?? GDAL_DEADLINE_MS;
}

/** Test hook: shorten the shared deadline so route timeouts are fast. */
export function setGdalDeadlineForTests(ms: number | null): void {
  deadlineOverride = ms;
}

/** Spawn a real gdal3.js worker thread that handles exactly one request. */
function defaultSpawnWorker(request: GdalRequest): GdalWorkerHandle {
  const worker = new Worker(new URL("./gdalWorker.mjs", import.meta.url), {
    workerData: request,
  });
  return {
    onMessage: (cb) => {
      worker.on("message", cb as (value: unknown) => void);
    },
    onError: (cb) => {
      worker.on("error", cb);
    },
    onExit: (cb) => {
      worker.on("exit", cb);
    },
    terminate: () => {
      void worker.terminate();
    },
  };
}

let spawnWorker: SpawnWorker = defaultSpawnWorker;

/** Test hook: substitute a controllable fake worker spawner. */
export function setSpawnWorkerForTests(fn: SpawnWorker): void {
  spawnWorker = fn;
}

/** Test hook: restore the real worker spawner. */
export function resetSpawnWorkerForTests(): void {
  spawnWorker = defaultSpawnWorker;
}

/** Rebuild a thrown error from the worker's serialized form. */
function reconstructError(error: SerializedError): Error {
  if (error.name === "GdbSourceError" && error.code) {
    return new GdbSourceError(
      error.code as ConstructorParameters<typeof GdbSourceError>[0],
      error.message,
      error.details,
    );
  }
  const rebuilt = new Error(error.message);
  if (error.name) rebuilt.name = error.name;
  return rebuilt;
}

/** Module-level FIFO tail: each op runs after the previous one has settled. */
let tail: Promise<void> = Promise.resolve();

/**
 * Enqueue a GDAL operation. Resolves with the worker's result (only after the
 * worker exits) or rejects with the op's structured error / a
 * {@link GdalOperationError} (`gdal_timeout` | `gdal_aborted` | `gdal_crashed`).
 */
export function runGdalOperation<T>(request: GdalRequest, options: RunOptions): Promise<T> {
  const deadlineAt = Date.now() + options.deadlineMs;
  const run = tail.then(() => execute<T>(request, deadlineAt, options.signal));
  // Advance the tail regardless of this op's outcome so the queue never wedges.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function execute<T>(
  request: GdalRequest,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A queued op whose deadline already elapsed never spawns a worker.
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new GdalOperationError("gdal_timeout", "GDAL operation timed out in queue."));
      return;
    }
    if (signal?.aborted) {
      reject(new GdalOperationError("gdal_aborted", "GDAL operation aborted."));
      return;
    }

    let settled = false;
    let mode: "timeout" | "aborted" | "worker_error" | null = null;
    let result: { value: T } | null = null;
    let opError: Error | null = null;
    let workerError: Error | null = null;

    const worker = spawnWorker(request);

    const deadlineTimer = setTimeout(() => {
      if (mode === null) {
        mode = "timeout";
        worker.terminate();
      }
    }, remaining);

    const onAbort = () => {
      if (mode === null) {
        mode = "aborted";
        worker.terminate();
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(deadlineTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    worker.onMessage((message) => {
      // Stash the outcome; settle only once the worker has actually exited so
      // the caller can safely delete the staged file afterward.
      if (mode !== null) return;
      if (message.ok) {
        result = { value: message.result as T };
      } else {
        opError = reconstructError(message.error);
      }
    });

    worker.onError((error) => {
      if (mode === null) {
        mode = "worker_error";
        workerError = error;
        worker.terminate();
      }
    });

    worker.onExit(() => {
      if (settled) return;
      settled = true;
      cleanup();
      if (mode === "timeout") {
        reject(new GdalOperationError("gdal_timeout", "GDAL operation timed out."));
      } else if (mode === "aborted") {
        reject(new GdalOperationError("gdal_aborted", "GDAL operation aborted."));
      } else if (mode === "worker_error") {
        reject(workerError ?? new GdalOperationError("gdal_crashed", "GDAL worker error."));
      } else if (opError) {
        reject(opError);
      } else if (result) {
        resolve(result.value);
      } else {
        reject(
          new GdalOperationError("gdal_crashed", "GDAL worker exited without a result."),
        );
      }
    });
  });
}
