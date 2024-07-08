import { Board } from "johnny-five";

const board = new Board({
  repl: false,
  debug: true,
});

board.on("ready", () => {
  // When board is connected and Firmata is flashed
  process.parentPort.postMessage({ type: "ready", port: board.port });
});

board.on("error", (error) => {
  // When board is found but no Firmata is flashed
  process.parentPort.postMessage({ type: "error", port: board.port, error });
});

board.on("fail", (error) => {
  // When board is not found
  process.parentPort.postMessage({ type: "fail", error });
});

board.on("warn", () => {
  process.parentPort.postMessage({ type: "warn" });
});

board.on("exit", () => {
  process.parentPort.postMessage({ type: "exit" });
});

board.on("close", () => {
  process.parentPort.postMessage({ type: "close" });
});
