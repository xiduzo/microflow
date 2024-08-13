"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Button = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Button extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Button(options);
        this.component.on('up', () => {
            this.value = false;
            this.eventEmitter.emit('inactive', this.value, false);
        });
        this.component.on('down', () => {
            this.value = true;
            this.eventEmitter.emit('active', this.value, false);
        });
        this.component.on('hold', () => {
            this.eventEmitter.emit('hold', this.value);
        });
    }
}
exports.Button = Button;
