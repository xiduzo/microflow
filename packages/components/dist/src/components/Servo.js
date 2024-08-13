"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Servo = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Servo extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Servo(options);
        this.component.on('move:complete', this.postMessage.bind(this, 'complete'));
    }
    min() {
        this.component.min();
        this.postMessage('change');
    }
    max() {
        this.component.max();
        this.postMessage('change');
    }
    to(position) {
        if (isNaN(position))
            return;
        this.component.to(position);
        this.postMessage('change');
    }
    rotate(speed = 0) {
        if (typeof speed === 'boolean') {
            speed = speed ? 1 : -1;
        }
        if (speed < 0.05 && speed > -0.05) {
            this.stop();
            return;
        }
        this.component.cw(speed);
        this.postMessage('change');
    }
    stop() {
        this.component.stop();
        this.postMessage('change');
    }
}
exports.Servo = Servo;
