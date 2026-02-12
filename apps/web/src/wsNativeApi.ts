import {
  type NativeApi,
  WS_CHANNELS,
  WS_METHODS,
  providerStreamFrameSchema,
  type ProviderStreamFrame,
  type ProvidersOpenStreamInput,
  type ProvidersOpenStreamResult,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
let lastWelcome: WsWelcomePayload | null = null;

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  if (lastWelcome) {
    try {
      listener(lastWelcome);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

function sanitizeOpenInput(input: ProvidersOpenStreamInput): ProvidersOpenStreamInput {
  const sanitized: ProvidersOpenStreamInput = {};

  if (input.afterSeq !== undefined) {
    sanitized.afterSeq = input.afterSeq;
  }
  if (input.sessionIds && input.sessionIds.length > 0) {
    sanitized.sessionIds = [...input.sessionIds];
  }
  if (input.eventKinds && input.eventKinds.length > 0) {
    sanitized.eventKinds = [...input.eventKinds];
  }
  if (input.includeExtensions && input.includeExtensions.length > 0) {
    sanitized.includeExtensions = [...input.includeExtensions];
  }
  if (input.includeDebugRaw !== undefined) {
    sanitized.includeDebugRaw = input.includeDebugRaw;
  }

  return sanitized;
}

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport();
  const providerStreamListeners = new Set<(frame: ProviderStreamFrame) => void>();
  let lastAppliedSeq = 0;
  let streamConfig: ProvidersOpenStreamInput = {};
  let streamOpenInFlight: Promise<ProvidersOpenStreamResult> | null = null;
  let streamOpen = false;
  let streamOpening = false;
  let pendingCloseAfterOpen = false;

  const openStream = async (
    overrides?: ProvidersOpenStreamInput,
  ): Promise<ProvidersOpenStreamResult> => {
    if (overrides) {
      streamConfig = sanitizeOpenInput(overrides);
    }

    if (streamOpenInFlight) {
      return streamOpenInFlight;
    }

    const openInput: ProvidersOpenStreamInput = {
      ...streamConfig,
      ...(lastAppliedSeq > 0 ? { afterSeq: lastAppliedSeq } : {}),
    };

    streamOpening = true;
    streamOpenInFlight = transport
      .request<ProvidersOpenStreamResult>(WS_METHODS.providersOpenStream, openInput)
      .then((result) => {
        const hasActiveListeners = providerStreamListeners.size > 0;
        const shouldCloseAfterOpen = pendingCloseAfterOpen && !hasActiveListeners;

        streamOpen = !shouldCloseAfterOpen;
        pendingCloseAfterOpen = false;

        if (shouldCloseAfterOpen) {
          void transport.request(WS_METHODS.providersCloseStream).catch(() => {
            // Ignore close errors while reconnect logic restores transport.
          });
        }

        if (result.mode !== "replay") {
          // Resync modes can legally move the cursor backwards after server restart.
          lastAppliedSeq = result.currentSeq;
        }

        return result;
      })
      .finally(() => {
        streamOpening = false;
        streamOpenInFlight = null;
      });

    return streamOpenInFlight;
  };

  const ensureStreamOpen = () => {
    if (providerStreamListeners.size === 0 || streamOpen) {
      return;
    }
    pendingCloseAfterOpen = false;

    void openStream().catch(() => {
      // Ignore open failures. Reconnect lifecycle retries automatically.
    });
  };

  transport.onConnectionStateChange((state) => {
    if (state === "open") {
      streamOpen = false;
      ensureStreamOpen();
      return;
    }

    streamOpen = false;
  });

  // Listen for server welcome and forward to registered listeners.
  // Also cache it so late subscribers (React effects) get it immediately.
  transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
    const payload = data as WsWelcomePayload;
    lastWelcome = payload;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  transport.subscribe(WS_CHANNELS.providerStream, (data) => {
    const parsed = providerStreamFrameSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const frame = parsed.data;

    if (frame.kind === "snapshot" && streamOpening) {
      lastAppliedSeq = frame.seq;
    } else if (frame.seq <= lastAppliedSeq) {
      return;
    } else {
      lastAppliedSeq = frame.seq;
    }

    for (const listener of providerStreamListeners) {
      try {
        listener(frame);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    todos: {
      list: async () => [],
      add: async () => [],
      toggle: async () => [],
      remove: async () => [],
    },
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
    },
    terminal: {
      run: async () => ({
        stdout: "",
        stderr: "Terminal not available in web mode",
        code: 1,
        signal: null,
        timedOut: false,
      }),
    },
    agent: {
      spawn: async () => "",
      kill: async () => {},
      write: async () => {},
      onOutput: () => () => {},
      onExit: () => () => {},
    },
    providers: {
      startSession: (input) => transport.request(WS_METHODS.providersStartSession, input),
      sendTurn: (input) => transport.request(WS_METHODS.providersSendTurn, input),
      interruptTurn: (input) => transport.request(WS_METHODS.providersInterruptTurn, input),
      respondToApproval: (input) =>
        transport.request(WS_METHODS.providersRespondToApproval, input),
      stopSession: (input) => transport.request(WS_METHODS.providersStopSession, input),
      listSessions: () => transport.request(WS_METHODS.providersListSessions),
      openStream: (input) => openStream(input),
      closeStream: async () => {
        pendingCloseAfterOpen = false;
        streamOpen = false;
        await transport.request(WS_METHODS.providersCloseStream);
      },
      onStream: (callback) => {
        providerStreamListeners.add(callback);
        pendingCloseAfterOpen = false;
        ensureStreamOpen();

        return () => {
          providerStreamListeners.delete(callback);
          if (providerStreamListeners.size === 0) {
            if (streamOpenInFlight) {
              pendingCloseAfterOpen = true;
              return;
            }

            streamOpen = false;
            pendingCloseAfterOpen = false;
            void transport.request(WS_METHODS.providersCloseStream).catch(() => {
              // Ignore close errors while transport reconnects.
            });
          }
        };
      },
    },
    projects: {
      list: () => transport.request(WS_METHODS.projectsList),
      add: (input) => transport.request(WS_METHODS.projectsAdd, input),
      remove: (input) => transport.request(WS_METHODS.projectsRemove, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
    },
  };

  instance = { api, transport };
  return api;
}
