const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

class Counter extends EventEmitter {
  #value = 0;
  id = null;

  constructor(options) {
    super();

    this.id = options.id;
  }

  set value(value) {
    this.#value = parseInt(value);
    this.emit("change", parseInt(value));
    setTimeout(() => {
      this.#postMessage("change");
    }, 25);
  }

  get value() {
    return this.#value;
  }

  increment(amount = 1) {
    this.value += parseInt(amount);
    this.#postMessage("increment");
  }

  decrement(amount = 1) {
    this.value -= parseInt(amount);
    this.#postMessage("decrement");
  }

  reset() {
    this.value = 0;
    this.#postMessage("reset");
  }

  set(value) {
    this.value = parseInt(value);
    this.#postMessage("set");
  }

  #postMessage(action) {
    process.parentPort.postMessage({
      nodeId: this.id,
      action,
      value: this.value,
    });
  }
}
