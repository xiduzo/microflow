const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

class Figma extends EventEmitter {
  #value = null;

  constructor(options) {
    super();

    this.on("change", () => {
      process.parentPort.postMessage({
        nodeId: options.id,
        action: "change",
        value: this.value,
      });
    });
  }

  set value(value) {
    this.#value = value;
    this.emit("change", value);
  }

  get value() {
    return this.#value;
  }

  increment(amount = 1) {
    this.value += amount;
  }

  decrement(amount = 1) {
    this.value -= amount;
  }

  true() {
    this.value = true;
  }

  false() {
    this.value = false;
  }

  toggle() {
    this.value = !this.value;
  }

  set(value) {
    this.value = value;
  }

  red(value) {
    this.value = { ...this.#value, r: value / 255 };
  }

  green(value) {
    this.value = { ...this.#value, g: value / 255 };
  }

  blue(value) {
    this.value = { ...this.#value, b: value / 255 };
  }

  opacity(value) {
    this.value = { ...this.#value, a: value / 100 };
  }
}

const led = new Figma();
