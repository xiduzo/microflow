"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mqtt = void 0;
const BaseComponent_1 = require("./BaseComponent");
class Mqtt extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
    }
    setExternal(value) {
        this.value = value;
        this.eventEmitter.emit('subscribe', this.value, false);
    }
    publish(message) {
        this.value = message;
    }
}
exports.Mqtt = Mqtt;
