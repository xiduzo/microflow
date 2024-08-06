const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

const board = new JohnnyFive.Board({
  repl: true
});

board.on("ready", () => {
  const piezo = new Piezo({ pin: 3 })

  board.repl.inject({
    // Allow limited on/off control access to the
    // Led instance from the REPL.
    freq: (frequency = 420, duration = 1000) => {
      piezo.frequency(frequency, duration);
    }
  });
})

class Piezo extends JohnnyFive.Piezo {
  #eventEmitter = new EventEmitter();
  #value = false;

  constructor(options) {
    super(options);
    this.options = options;
  }

  set value(value) {
    this.#value = value;
  }

  get value() {
    return this.#value;
  }

  stop() {
    super.off();
    this.value = false;
  }

  frequency(frequency = 420, duration = 1000) {
    super.frequency(frequency, duration);
    this.value = true;

    setTimeout(() => {
      this.value = false;
      this.stop()
    }, duration);
  }

  play(tune = { tempo: 1000, song: ["C4"] }) {
    super.play(tune, () => {
      this.value = false;
    });
    this.value = true;
  }

  postMessage(action) {
    if (action !== "change") {
      this.#eventEmitter.emit("change", this.value);
    }

    // process.parentPort.postMessage({ nodeId: this.options.id, action, value: this.value });
  }
}
