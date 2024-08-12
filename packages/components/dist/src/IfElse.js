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
var _IfElse_instances, _IfElse_value, _IfElse_validator, _IfElse_postMessage;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IfElse = void 0;
const events_1 = __importDefault(require("events"));
class IfElse extends events_1.default {
    constructor(options) {
        super();
        _IfElse_instances.add(this);
        this.options = options;
        _IfElse_value.set(this, false);
        this.on('change', __classPrivateFieldGet(this, _IfElse_instances, "m", _IfElse_postMessage).bind(this, 'change'));
        this.on('true', __classPrivateFieldGet(this, _IfElse_instances, "m", _IfElse_postMessage).bind(this, 'true'));
        this.on('false', __classPrivateFieldGet(this, _IfElse_instances, "m", _IfElse_postMessage).bind(this, 'false'));
    }
    get value() {
        return __classPrivateFieldGet(this, _IfElse_value, "f");
    }
    set value(value) {
        __classPrivateFieldSet(this, _IfElse_value, value, "f");
        this.emit(value ? 'true' : 'false', value);
    }
    check(input) {
        const validator = __classPrivateFieldGet(this, _IfElse_instances, "m", _IfElse_validator).call(this);
        this.value = validator(input);
    }
}
exports.IfElse = IfElse;
_IfElse_value = new WeakMap(), _IfElse_instances = new WeakSet(), _IfElse_validator = function _IfElse_validator() {
    switch (this.options.validator) {
        case 'boolean':
            return (input) => input === true ||
                ['1', 'true', 'on', 'yes'].includes(String(input).toLowerCase());
        case 'number':
            const [num1, num2] = this.options.validatorArgs.map(Number);
            switch (this.options.subValidator) {
                case 'equal to':
                    return (input) => input == num1;
                case 'greater than':
                    return (input) => input > num1;
                case 'less than':
                    return (input) => input < num1;
                case 'between':
                    return (input) => input > num1 && input < num2;
                case 'outside':
                    return (input) => input < num1 && input > num2;
                case 'is even':
                    return (input) => Math.round(input) % 2 === 0;
                case 'is odd':
                    return (input) => Math.round(input) % 2 !== 0;
                default:
                    return () => false;
            }
        case 'text':
            const [expected] = this.options.validatorArgs.map(String);
            switch (this.options.subValidator) {
                case 'equal to':
                    return (input) => input === expected;
                case 'includes':
                    return (input) => input.includes(expected);
                case 'starts with':
                    return (input) => input.startsWith(expected);
                case 'ends with':
                    return (input) => input.endsWith(expected);
                default:
                    return () => false;
            }
        default:
            return () => false;
    }
}, _IfElse_postMessage = function _IfElse_postMessage(action) {
    if (action !== 'change') {
        this.emit('change', this.value);
    }
    process.parentPort.postMessage({
        nodeId: this.options.id,
        action,
        value: this.value,
    });
};
