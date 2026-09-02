import * as net from "node:net";
import type { PiServerListener } from "@earendil-works/pi-server";

/**
 * pi-server does not re-export `ByteConnection`/`ByteConnectionAcceptor` from
 * its root entry, so the connection objects below are written structurally
 * against the `PiServerListener` contract (contextual typing does the check).
 */

export interface TcpTransportOptions {
  host: string;
  port: number;
}

export function createTcpListener(options: TcpTransportOptions): PiServerListener {
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();
  let boundPort = options.port;

  const listener: PiServerListener = {
    get address() {
      return `tcp://${options.host}:${boundPort}`;
    },
    start(accept): Promise<void> {
      return new Promise((resolve, reject) => {
        server = net.createServer((socket) => {
          sockets.add(socket);
          const handler = accept({
            get closed() {
              return socket.destroyed;
            },
            send(chunk: Uint8Array): Promise<void> {
              return new Promise((res, rej) => {
                socket.write(chunk, (error) => (error ? rej(error) : res()));
              });
            },
            close(finalChunk?: Uint8Array): void {
              if (finalChunk) socket.end(finalChunk);
              else socket.end();
            },
          });
          socket.on("data", (chunk: Buffer) => handler.onData(new Uint8Array(chunk)));
          socket.on("close", () => {
            sockets.delete(socket);
            handler.onClose();
          });
          socket.on("error", (error) => handler.onError(error));
        });
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          const bound = server?.address();
          if (bound && typeof bound === "object") boundPort = bound.port;
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (!server) return resolve();
        server.close(() => resolve());
        server = undefined;
      });
    },
  };
  return listener;
}

/** Client-side counterpart used by @kaya/cli via pi-client's ByteTransportFactory. */
export function createTcpTransportFactory(
  options: TcpTransportOptions,
): (handlers: {
  onData(chunk: Uint8Array): void;
  onClose(): void;
  onError(error: Error): void;
}) => Promise<{ send(chunk: Uint8Array): Promise<void>; close(): void }> {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(options.port, options.host);
      const onConnectError = (error: Error) => reject(error);
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("data", (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
        socket.on("close", () => handlers.onClose());
        socket.on("error", (error) => handlers.onError(error));
        resolve({
          send(chunk: Uint8Array): Promise<void> {
            return new Promise((res, rej) => {
              socket.write(chunk, (error) => (error ? rej(error) : res()));
            });
          },
          close(): void {
            socket.end();
          },
        });
      });
    });
}
