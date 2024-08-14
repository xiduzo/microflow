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
    /**
     * Listen to an event
     *
     * @param action - The event to listen to
     * @param callback - The callback to run when the event is triggered
     *
     * @param args Passing a second argument to `args` when emitting the event will determine if the change event should be emitted.
     *
     * @example
     *
     * // Emitting the change event
     * this.eventEmitter.emit('change', this.value);
     * this.eventEmitter.emit('change', this.value, true);
     *
     * // Not emitting the change event
     * this.eventEmitter.emit('change', this.value, false);
     */
    on(action, callback) {
        this.eventEmitter.on(action, args => {
            callback(args);
            this.postMessage(action, args[1] === undefined || !!args[1]);
        });
    }
    postMessage(action, emitChange = true) {
        if (action !== 'change' && emitChange) {
            this.eventEmitter.emit('change', this._value);
        }
        (0, postMessageToElectronMain_1.postMessageToElectronMain)({
            action,
            nodeId: this._id,
            value: this.value,
        });
    }
    postErrorMessage(action, error) {
        (0, postMessageToElectronMain_1.postMessageToElectronMain)({
            action: action,
            nodeId: this._id,
            value: error,
        });
    }
}
exports.BaseComponent = BaseComponent;
