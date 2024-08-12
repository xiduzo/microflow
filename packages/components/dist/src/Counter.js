"use strict";
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _Counter_instances, _Counter_value, _Counter_postMessage;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Counter = void 0;
const events_1 = __importDefault(require("events"));
class Counter extends events_1.default {
    constructor(options) {
        super();
        _Counter_instances.add(this);
        this.options = options;
        _Counter_value.set(this, 0);
        this.on('change', __classPrivateFieldGet(this, _Counter_instances, "m", _Counter_postMessage).bind(this, 'change'));
    }
    set value(value) {
        __classPrivateFieldSet(this, _Counter_value, parseInt(value), "f");
        this.emit('change', this.value);
    }
    get value() {
        return __classPrivateFieldGet(this, _Counter_value, "f");
    }
    increment(amount = 1) {
        this.value += amount;
    }
    decrement(amount = 1) {
        this.value -= amount;
    }
    reset() {
        this.value = 0;
    }
    set(value) {
        this.value = value;
    }
}
exports.Counter = Counter;
_Counter_value = new WeakMap(), _Counter_instances = new WeakSet(), _Counter_postMessage = function _Counter_postMessage(action) {
    if (action !== 'change') {
        this.emit('change', this.value);
    }
    process.parentPort.postMessage({
        nodeId: this.options.id,
        action,
        value: this.value,
    });
};
