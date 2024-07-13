const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");

try {
  const board = new JohnnyFive.Board({
    repl: false,
    debug: true,
  });
  log.debug("Board is being checked", board.port);

  board.on("info", (event) => {
    process.parentPort.postMessage({
      type: "info",
      message: event.message,
      class: event.class,
    });
  });

  board.on("ready", () => {
    // When board is connected and Firmata is flashed
    process.parentPort.postMessage({
      type: "ready",
      port: board.port,
      pins: Object.entries(board.pins).reduce((acc, [key, value]) => {
        acc.push({
          pin: Number(key),
          ...value,
        });
        return acc;
      }, []),
    });
  });

  board.on("error", (error) => {
    // When board is found but no Firmata is flashed
    process.parentPort.postMessage({
      type: "error",
      message: error.message,
      port: board.port,
    });
  });

  board.on("fail", (event) => {
    // When board is not found
    process.parentPort.postMessage({
      type: "fail",
      message: event.message,
      class: event.class,
    });
  });

  board.on("warn", (event) => {
    // TODO: find out when this fires
    process.parentPort.postMessage({
      type: "warn",
      message: event.message,
      class: event.class,
    });
  });

  board.on("exit", () => {
    // TODO: find out when this fires
    process.parentPort.postMessage({ type: "exit" });
  });

  board.on("close", () => {
    // TODO: find out when this fires
    process.parentPort.postMessage({ type: "close" });
  });
} catch (error) {
  log.error("something went wrong", { error });
  process.parentPort.postMessage({
    type: "error",
    message: error.message,
    port: board.port,
  });
}
