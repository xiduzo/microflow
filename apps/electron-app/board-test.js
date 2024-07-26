const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

class Map extends EventEmitter {
  #value = [0, 0];
  #formatter = new Intl.NumberFormat("en-US", { style: "decimal", maximumFractionDigits: 2 });

  constructor(options) {
    super();
    this.options = options;
  }

  get value() {
    return this.#value;
  }

  set value(value) {
    this.#value = value;
    this.#postMessage("to", value);
  }

  from(input) {
    const inMin = this.options.from[0] ?? 0;
    const inMax = this.options.from[1] ?? 1023;
    const outMin = this.options.to[0] ?? 0;
    const outMax = this.options.to[1] ?? 1023;

    const output = ((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
    this.value = [input, this.#formatter.format(output)]
  }

  #postMessage(action) {
    if (action !== "change") {
      this.emit("change", this.value);
    }

    process.parentPort.postMessage({ nodeId: this.options.id, action, value: this.value });
  }
}

class Sensor extends JohnnyFive.Sensor {
  #value = 0;

  constructor(options) {
    super(options);

    this.on("change", () => {
      this.#value = this.raw;
      this.#postMessage("change");
    })
  }

  get value() {
    return this.#value;
  }

  #postMessage(action) {
    if (action !== "change") {
      this.emit("change", this.value);
    }

    process.parentPort.postMessage({ nodeId: this.options.id, action, value: this.value });
  }
}
