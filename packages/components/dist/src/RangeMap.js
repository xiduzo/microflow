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
var _RangeMap_instances, _RangeMap_value, _RangeMap_postMessage;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RangeMap = void 0;
const events_1 = __importDefault(require("events"));
class RangeMap extends events_1.default {
    constructor(options) {
        super();
        _RangeMap_instances.add(this);
        this.options = options;
        _RangeMap_value.set(this, [0, 0]);
        this.on('to', __classPrivateFieldGet(this, _RangeMap_instances, "m", _RangeMap_postMessage).bind(this, 'to'));
        this.on('change', __classPrivateFieldGet(this, _RangeMap_instances, "m", _RangeMap_postMessage).bind(this, 'change'));
    }
    get value() {
        return __classPrivateFieldGet(this, _RangeMap_value, "f");
    }
    set value(value) {
        const previousValue = __classPrivateFieldGet(this, _RangeMap_value, "f");
        __classPrivateFieldSet(this, _RangeMap_value, value, "f");
        __classPrivateFieldGet(this, _RangeMap_instances, "m", _RangeMap_postMessage).call(this, 'change');
        if (previousValue[1] !== value[1]) {
            this.emit('to', value[1]);
        }
    }
    from(input) {
        var _a, _b, _c, _d;
        if (typeof input === 'boolean') {
            input = input ? 1 : 0;
        }
        if (typeof input === 'string') {
            input = parseFloat(input);
        }
        const inMin = (_a = this.options.from[0]) !== null && _a !== void 0 ? _a : 0;
        const inMax = (_b = this.options.from[1]) !== null && _b !== void 0 ? _b : 1023;
        const outMin = (_c = this.options.to[0]) !== null && _c !== void 0 ? _c : 0;
        const outMax = (_d = this.options.to[1]) !== null && _d !== void 0 ? _d : 1023;
        const output = ((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
        const distance = outMax - outMin;
        const normalizedOutput = parseFloat(String(output)).toFixed(distance <= 10 ? 1 : 0);
        this.value = [input, Number(normalizedOutput)];
    }
}
exports.RangeMap = RangeMap;
_RangeMap_value = new WeakMap(), _RangeMap_instances = new WeakSet(), _RangeMap_postMessage = function _RangeMap_postMessage(action) {
    if (action !== 'change') {
        this.emit('change', this.value);
    }
    process.parentPort.postMessage({
        nodeId: this.options.id,
        action,
        value: this.value,
    });
};
