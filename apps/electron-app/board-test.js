const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

try {
  const board = new JohnnyFive.Board({
    repl: false,
    debug: false,
  });

  board.on("info", (event) => {
    log.info("board info");
    process.parentPort.postMessage({ type: "info", message: event.message });
  }); // board - info

  board.on("ready", () => {
    log.info("board is ready");
    process.parentPort.postMessage({ type: "ready" });

    /*
     * Create nodes
     */
    const Button_1 = new CustomJohnnyFiveButton({ pin: 8 });
    const Counter_2 = new Counter();
    const Led_3 = new CustomJohnnyFiveLed({ pin: 13 });

    /*
     * Node handlers
     */
    Button_1.on("up", () => {
      // Inform main process
      process.parentPort.postMessage({ id: "1", action: "up" });

      Counter_2.increment();
      Led_3.toggle();
    }); // Button_1 - up
  }); // board - ready;

  /*
   * Board events in order to communicate with the main process
   */
  board.on("error", (error) => {
    log.error("board error", { error });
    process.parentPort.postMessage({ type: "error", message: error.message });
  }); // board - error

  board.on("fail", (event) => {
    log.warn("board fail", { event });
    process.parentPort.postMessage({ type: "fail", message: event.message });
  }); // board - fail

  board.on("warn", (event) => {
    log.warn("board warn", { event });
    process.parentPort.postMessage({ type: "warn", message: event.message });
  }); // board - warn

  board.on("exit", () => {
    log.info("board exit");
    process.parentPort.postMessage({ type: "exit" });
  }); // board - exit

  board.on("close", () => {
    log.info("board close");
    process.parentPort.postMessage({ type: "close" });
  }); // board - close
} catch (error) {
  log.error("something went wrong", { error });
}

class Counter extends EventEmitter {
  #count = 0;
  id = null;

  constructor(id) {
    super();

    this.id = id;
  }

  set count(value) {
    this.#count = value;
    this.emit("change", value);
  }

  get count() {
    return this.#count;
  }

  increment(amount = 1) {
    this.count += parseInt(amount);
  }

  decrement(amount = 1) {
    this.count -= parseInt(amount);
  }

  reset() {
    this.count = 0;
  }

  set(value) {
    this.count = parseInt(value);
  }
}

class CustomJohnnyFiveButton extends JohnnyFive.Button {
  get value() {
    return this.value;
  }

  constructor(options) {
    super(options);

    this.on("up", this.#postMessage.bind(this, "up"));
    this.on("down", this.#postMessage.bind(this, "down"));
    this.on("hold", this.#postMessage.bind(this, "hold"));
    this.on("change", this.#postMessage.bind(this, "change"));
  }

  #postMessage(action) {
    if (action !== "change") {
      this.emit("change", this.value);
    }

    process.parentPort.postMessage({
      nodeId: this.id,
      action,
      value: this.value,
    });
  }
}

const test = new CustomJohnnyFiveButton({ pin: 8 });

class CustomJohnnyFiveLed extends JohnnyFive.Led {
  #previousValue = 0;
  #eventEmitter = new EventEmitter();

  constructor(options) {
    super(options);

    setInterval(() => {
      if (this.#previousValue !== this.value) {
        this.#eventEmitter.emit("change");
        this.#postMessage("change");
      }

      this.#previousValue = this.value;
    }, 25);
  }

  on(action, callback) {
    if (!action) {
      super.on();
      this.#postMessage("on");
      return;
    }

    this.#eventEmitter.on(action, callback);
  }

  off() {
    super.off();
    this.#postMessage("off");
  }

  toggle() {
    super.toggle();
    this.#postMessage("toggle");
  }

  #postMessage(action) {
    process.parentPort.postMessage({
      nodeId: this.id,
      action,
      value: this.value,
    });
  }
}
