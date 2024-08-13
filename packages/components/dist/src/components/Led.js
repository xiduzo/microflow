"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Led = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Led extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Led(options);
    }
    // Highjack the on method
    // to allow for a custom actions
    on(action, callback) {
        if (action) {
            this.eventEmitter.on(action, callback);
            return;
        }
        this.component.on();
        this.value = 1;
    }
    off() {
        this.component.off();
        this.value = 0;
    }
    toggle() {
        this.component.toggle();
        this.value = this.value === 0 ? 1 : 0;
    }
}
exports.Led = Led;
