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

  board.on("ready", (event) => {
    const button = new JohnnyFive.Button({
      pin: 8,
      holdtime: 1000,
    });
    const button2 = new JohnnyFive.Button({
      pin: 8,
      // isPullup: true,
      holdtime: 666,
    });
    console.log("Board ready");
    button.on("down", () => {
      console.log("Button down");
      led.toggle();
    });

    button.on("press", () => {
      console.log("Button press");
    });

    button.on("release", () => {
      console.log("Button release");
    });

    button.on("up", () => {
      console.log("Button up");
      led.toggle();
    });

    button.on("hold", (holdtime) => {
      console.log("Button hold", holdtime);
    });

    button2.on("hold", (holdtime) => {
      console.log("Button2 hold", holdtime);
    });

    led = new JohnnyFive.Led(13);

    // board.repl.inject({
    //   led,
    // });
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
