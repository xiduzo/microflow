"use strict";
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _IfElse_instances, _IfElse_validator;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IfElse = void 0;
const BaseComponent_1 = require("./BaseComponent");
class IfElse extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        _IfElse_instances.add(this);
        this.options = options;
    }
    check(input) {
        const validator = __classPrivateFieldGet(this, _IfElse_instances, "m", _IfElse_validator).call(this);
        this.value = validator(input);
        this.eventEmitter.emit(this.value ? 'true' : 'false', this.value, false);
    }
}
exports.IfElse = IfElse;
_IfElse_instances = new WeakSet(), _IfElse_validator = function _IfElse_validator() {
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
};
