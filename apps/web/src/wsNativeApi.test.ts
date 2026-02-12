import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WS_CHANNELS,
  WS_METHODS,
  type ProvidersOpenStreamResult,
} from "@t3tools/contracts";

type PushListener = (data: unknown) => void;
type ConnectionState = "open" | "closed";
type ConnectionListener = (state: ConnectionState) => void;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const transportState = {
  openRequests: [] as Array<{ params: unknown }>,
  closeRequests: [] as Array<{ params: unknown }>,
  openDeferredQueue: [] as Array<ReturnType<typeof createDeferred<ProvidersOpenStreamResult>>>,
  latest: null as MockWsTransport | null,
  reset() {
    this.openRequests = [];
    this.closeRequests = [];
    this.openDeferredQueue = [];
    this.latest = null;
  },
};

class MockWsTransport {
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly connectionListeners = new Set<ConnectionListener>();

  constructor() {
    transportState.latest = this;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === WS_METHODS.providersOpenStream) {
      transportState.openRequests.push({ params });
      const deferred = transportState.openDeferredQueue.shift();
      if (!deferred) {
        return Promise.resolve({
          mode: "snapshot",
          currentSeq: 0,
          oldestSeq: 0,
          replayedCount: 0,
        } as T);
      }
      return deferred.promise as Promise<T>;
    }

    if (method === WS_METHODS.providersCloseStream) {
      transportState.closeRequests.push({ params });
      return Promise.resolve(undefined as T);
    }

    return Promise.resolve(undefined as T);
  }

  subscribe(channel: string, listener: PushListener): () => void {
    const listeners = this.listeners.get(channel) ?? new Set<PushListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  onConnectionStateChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  emitPush(channel: string, data: unknown): void {
    const listeners = this.listeners.get(channel);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(data);
    }
  }
}

vi.mock("./wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createWsNativeApi stream lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    transportState.reset();
  });

  it("does not close the stream when open is in flight and a listener re-subscribes", async () => {
    const openDeferred = createDeferred<ProvidersOpenStreamResult>();
    transportState.openDeferredQueue.push(openDeferred);

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    const frames: unknown[] = [];
    const unsubscribeA = api.providers.onStream((frame) => {
      frames.push(frame);
    });

    expect(transportState.openRequests).toHaveLength(1);

    unsubscribeA();
    expect(transportState.closeRequests).toHaveLength(0);

    const unsubscribeB = api.providers.onStream((frame) => {
      frames.push(frame);
    });
    expect(transportState.openRequests).toHaveLength(1);

    openDeferred.resolve({
      mode: "snapshot",
      currentSeq: 10,
      oldestSeq: 1,
      replayedCount: 0,
    });
    await flushMicrotasks();

    expect(transportState.closeRequests).toHaveLength(0);

    transportState.latest?.emitPush(WS_CHANNELS.providerStream, {
      kind: "event",
      seq: 11,
      at: "2026-02-10T08:30:00.000Z",
      data: {
        type: "error",
        code: "runtime/error",
        message: "boom",
      },
    });

    expect(frames).toHaveLength(1);

    unsubscribeB();
    await flushMicrotasks();

    expect(transportState.closeRequests).toHaveLength(1);
  });
});
