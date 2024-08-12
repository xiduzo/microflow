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
var _Interval_instances, _Interval_minIntervalInMs, _Interval_value, _Interval_interval, _Interval_postMessage;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interval = void 0;
const events_1 = __importDefault(require("events"));
class Interval extends events_1.default {
    constructor(options) {
        super();
        _Interval_instances.add(this);
        this.options = options;
        _Interval_minIntervalInMs.set(this, 500);
        _Interval_value.set(this, 0);
        this.on('change', __classPrivateFieldGet(this, _Interval_instances, "m", _Interval_postMessage).bind(this, 'change'));
        setInterval(() => {
            this.value = performance.now();
        }, __classPrivateFieldGet(this, _Interval_instances, "m", _Interval_interval).call(this, options.interval));
    }
    set value(value) {
        __classPrivateFieldSet(this, _Interval_value, value, "f");
        this.emit('change', value);
    }
    get value() {
        return __classPrivateFieldGet(this, _Interval_value, "f");
    }
}
exports.Interval = Interval;
_Interval_minIntervalInMs = new WeakMap(), _Interval_value = new WeakMap(), _Interval_instances = new WeakSet(), _Interval_interval = function _Interval_interval(interval) {
    const parsed = parseInt(String(interval));
    const isNumber = !isNaN(parsed);
    if (!isNumber) {
        return __classPrivateFieldGet(this, _Interval_minIntervalInMs, "f");
    }
    return Math.max(__classPrivateFieldGet(this, _Interval_minIntervalInMs, "f"), parsed);
}, _Interval_postMessage = function _Interval_postMessage(action) {
    if (action !== 'change') {
        this.emit('change', this.value);
    }
    process.parentPort.postMessage({
        nodeId: this.options.id,
        action,
        value: this.value,
    });
};
