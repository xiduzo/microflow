const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

const board = new JohnnyFive.Board({
  repl: true
});

board.on("ready", () => {
  const servo = new Servo({ pin: 9, id: "servo", range: [5, 175], type: "continuous" });
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
      console.log("ccw", servo.position);
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

class Servo extends JohnnyFive.Servo {
  constructor(options) {
    log.debug("creating servo", options);
    super(options);
    log.info("servo created", options);
    this.options = options;

    this.on("move:complete", this.postMessage.bind(this, "complete"));
  }

  min() {
    super.min()
    this.postMessage("change");
  }

  max() {
    super.max();
    this.postMessage("change");
  }

  to(position) {
    super.to(position);
    this.postMessage("change");
  }

  cw(speed = 1) {
    log.info("cw", speed);
    super.cw(speed);
    this.postMessage("change");
  }

  ccw(speed = 1) {
    log.info("ccw", speed);
    super.ccw(speed);
    this.postMessage("change");
  }

  stop() {
    super.stop();
    this.postMessage("change");
  }

  postMessage(action) {
    if (!this.options) return;
    log.info(action);
    if (action !== "change") {
      this.emit("change", this.value);
    }

  }
}
