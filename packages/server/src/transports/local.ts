import type { PiServerListener } from "@earendil-works/pi-server";

/**
 * In-process transport pair for kaya's combined mode: the CLI hosts the server
 * and connects to it through real pi-protocol frames with no sockets involved.
 * Same code path as split mode; only byte delivery differs. Connection objects
 * are written structurally against pi-server's unexported connection contract.
 */
export interface LocalEndpoint {
  listener: PiServerListener;
  transportFactory: (handlers: {
    onData(chunk: Uint8Array): void;
    onClose(): void;
    onError(error: Error): void;
  }) => { send(chunk: Uint8Array): Promise<void>; close(): void };
  address: string;
}

interface ByteHandler {
  onData(chunk: Uint8Array): void;
  onClose(): void;
  onError(error: Error): void;
}

type Acceptor = Parameters<PiServerListener["start"]>[0];

export function createLocalEndpoint(): LocalEndpoint {
  let acceptor: Acceptor | undefined;

  const listener: PiServerListener = {
    address: "local://kaya",
    start(accept): Promise<void> {
      acceptor = accept;
      return Promise.resolve();
    },
    close(): Promise<void> {
      acceptor = undefined;
      return Promise.resolve();
    },
  };

  const transportFactory: LocalEndpoint["transportFactory"] = (handlers) => {
    let serverHandler: ByteHandler | undefined;
    let closed = false;

    if (!acceptor) throw new Error("local listener not started");
    serverHandler = acceptor({
      get closed() {
        return closed;
      },
      send(chunk: Uint8Array): Promise<void> {
        if (closed) return Promise.reject(new Error("connection closed"));
        queueMicrotask(() => handlers.onData(chunk));
        return Promise.resolve();
      },
      close(finalChunk?: Uint8Array): void {
        if (closed) return;
        if (finalChunk) queueMicrotask(() => handlers.onData(finalChunk));
        closed = true;
        queueMicrotask(() => handlers.onClose());
      },
    });

    return {
      send(chunk: Uint8Array): Promise<void> {
        if (closed) return Promise.reject(new Error("connection closed"));
        queueMicrotask(() => serverHandler?.onData(chunk));
        return Promise.resolve();
      },
      close(): void {
        if (closed) return;
        closed = true;
        queueMicrotask(() => serverHandler?.onClose());
      },
    };
  };

  return { listener, transportFactory, address: "local://kaya" };
}
