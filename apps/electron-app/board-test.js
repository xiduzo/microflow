const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

try {
  const board = new JohnnyFive.Board({
    repl: false,
    debug: false,
  });

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
  constructor(options) {
    super(options);

    this.on("up", () => {
      super.emit("change");
    });

    this.on("down", () => {
      super.emit("change");
    });

    this.on("hold", () => {
      super.emit("change");
    });
  }
}

class CustomJohnnyFiveLed extends JohnnyFive.Led {
  #previousIsOn = false;
  #eventEmitter = new EventEmitter();

  constructor(options) {
    super(options);
    this.#interval();
  }

  #interval() {
    setInterval(() => {
      if (this.#previousIsOn !== this.isOn) {
        this.#eventEmitter.emit("change");
      }

      this.#previousIsOn = this.isOn;
    }, 25);
  }

  on(event, callback) {
    if (!event) {
      super.on();
      return;
    }

    this.#eventEmitter.on(event, callback);
  }
}
