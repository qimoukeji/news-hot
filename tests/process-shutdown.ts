import type { ChildProcess } from "node:child_process";

// Windows terminates a process on child.kill("SIGTERM") without dispatching its handler.
// Relay a test-only IPC request to the same handler there; POSIX still receives the real signal.
export const shutdownTransport = process.platform === "win32" ? "Windows IPC shutdown" : "SIGTERM shutdown";

export function relayWindowsShutdown() {
  if (process.platform === "win32") process.on("message", message => {
    if ((message as { testShutdown?: boolean })?.testShutdown) process.emit("SIGTERM");
  });
}

export function requestShutdown(child: ChildProcess) {
  if (process.platform === "win32") child.send({ testShutdown: true });
  else child.kill("SIGTERM");
}
