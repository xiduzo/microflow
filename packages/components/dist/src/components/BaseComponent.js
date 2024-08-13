"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseComponent = void 0;
const events_1 = __importDefault(require("events"));
const postMessageToElectronMain_1 = require("../utils/postMessageToElectronMain");
class BaseComponent {
    constructor(options) {
        this.eventEmitter = new events_1.default();
        this._value = options.value;
        this._id = options.id;
        this.eventEmitter.on('change', this.postMessage.bind(this, 'change'));
    }
    get value() {
        return this._value;
    }
    set value(value) {
        const previousValue = this._value;
        this._value = value;
        if (JSON.stringify(previousValue) !== JSON.stringify(value)) {
            this.eventEmitter.emit('change', value);
        }
    }
    on(action, callback) {
        this.eventEmitter.on(action, callback);
    }
    postMessage(action) {
        if (action !== 'change') {
            this.eventEmitter.emit('change', this._value);
        }
        (0, postMessageToElectronMain_1.postMessageToElectronMain)({
            action,
            nodeId: this._id,
            value: this.value,
        });
    }
}
exports.BaseComponent = BaseComponent;
