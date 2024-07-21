const JohnnyFive = require("johnny-five");
const log = require("electron-log/node");
const EventEmitter = require("events");

class IfElse extends EventEmitter {
  #value = null;

  constructor(options) {
    super();

    this.options = options;

    this.on("change", () => {
      process.parentPort.postMessage({
        nodeId: options.id,
        action: "change",
        value: this.value,
      });
    });
  }

  get value() {
    return this.#value;
  }

  set value(value) {
    if (this.#value !== value) {
      this.emit("change");
    }

    this.#value = value;
    this.emit(value ? "true" : "false");
  }

  check(input) {
    this.value = this.#validator(input, ...this.options.validatorArgs);
  }

  #validator() {
    switch (validator) {
      case "boolean":
        switch (subValidator) {
          case "true":
            return (input) => input === true;
          case "false":
            return (input) => input === false;
          default:
            return () => false;
        }
      case "numeric":
        switch (subValidator) {
          case "equal to":
            return (input) => input === 0;
          case "greater than":
            return (input, expected) => input > expected;
          case "less than":
            return (input, expected) => input < expected;
          case "in range":
            return (input, min, max) => input >= min && input <= max;
          case "outside range":
            return (input, min, max) => input < min || input > max;
          case "is even":
            return (input) => input % 2 === 0;
          case "is odd":
            return (input) => input % 2 !== 0;
          default:
            return () => false;
        }
      case "string":
        switch (subValidator) {
          case "equal to":
            return (input, expected) => input === expected;
          case "contains":
            return (input, expected) => input.includes(expected);
          case "starts with":
            return (input, expected) => input.startsWith(expected);
          case "ends with":
            return (input, expected) => input.endsWith(expected);
          default:
            return () => false;
        }
    }
  }
}
