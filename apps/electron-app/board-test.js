const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

class Servo extends JohnnyFive.Servo {
  constructor(options) {
    super(options);
    log.info("servo created", options);
    this.options = options;

    this.on("move:complete", this.#postMessage.bind(this, "complete"))
    this.center();
  }
  min() {
    super.max()
    log.info("servo min");
  }

  max() {
    super.max();
    log.info("servo max");
  }

  #postMessage(action) {
    if (action !== "change") {
      this.emit("change", this.value);
    }

    process.parentPort.postMessage({ nodeId: this.options.id, action, value: this.value });
  }
}

const board = new JohnnyFive.Board({
  repl: true
});

board.on("ready", () => {
  const servo = new JohnnyFive.Servo({ pin: 5, id: "servo", range: [5, 175] });
  servo.on("move:complete", () => {
    console.log("move:complete", servo.value);
  })

  board.repl.inject({
    // Allow limited on/off control access to the
    // Led instance from the REPL.
    cw: function (speed = 1) {
      console.log("cw", servo.last);
      servo.cw(speed);
    },
    ccw: function (speed = 1) {
      console.log("ccw", servo.last);
      servo.ccw(speed);
    },
    stop: function () {
      console.log("stop", servo.last);
      servo.stop();
    },
    center: function () {
      console.log("center", servo.last);
      servo.center();
    },
    to: function (value) {
      console.log("to", servo.last);
      servo.to(value);
    },
    min: function () {
      console.log("min", servo.last);
      servo.min();
    },
    max: function () {
      console.log("max", servo.last);
      servo.max();
    },
    sweep: function () {
      console.log("sweep", servo.last);
      servo.sweep();
    }
  });
})
