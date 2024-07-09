const JohnnyFive = require("johnny-five");

try {
  /**
   * @type {JohnnyFive.Led}
   */
  let led;

  const board = new JohnnyFive.Board({
    repl: false,
    debug: true,
  });

  const button = new JohnnyFive.Button(2);

  button.on("hold", (holdTime) => {});

  board.on("close", (event) => {});

  board.on("ready", (event) => {
    console.log(board.pins);
    led = new JohnnyFive.Led(13);

    // board.repl.inject({
    //   led,
    // });
  });

  process.parentPort.on("message", (data) => {
    console.log("message received", data);
    led.toggle();
  });
} catch (error) {
  console.error(error);
}

// MODES: {
//     INPUT: 0,
//     OUTPUT: 1,
//     ANALOG: 2,
//     PWM: 3,
//     SERVO: 4,
//     SHIFT: 5,
//     I2C: 6,
//     ONEWIRE: 7,
//     STEPPER: 8,
//     SERIAL: 10,
//     PULLUP: 11,
//     IGNORE: 127,
//     PING_READ: 117,
//     UNKOWN: 16
//   }
