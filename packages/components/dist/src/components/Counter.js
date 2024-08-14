"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Counter = void 0;
const node_1 = __importDefault(require("electron-log/node"));
const BaseComponent_1 = require("./BaseComponent");
class Counter extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
    }
    increment(amount = 1) {
        try {
            this.value += this.inputToNumber(amount);
        }
        catch (error) {
            node_1.default.warn('Invalid value type to increment counter', { amount, error });
            this.postErrorMessage('increment', new Error(`${amount} is not a valid number`));
        }
    }
    decrement(amount = 1) {
        try {
            this.value -= this.inputToNumber(amount);
        }
        catch (error) {
            node_1.default.warn('Invalid value type to decrement counter', { amount, error });
            this.postErrorMessage('decrement', new Error(`${amount} is not a valid number`));
        }
    }
    reset() {
        this.value = 0;
    }
    set(value) {
        try {
            this.value = this.inputToNumber(value);
        }
        catch (error) {
            node_1.default.warn('Invalid value type to set counter', { value, error });
            this.postErrorMessage('set', new Error(`${value} is not a valid number`));
        }
    }
    inputToNumber(input) {
        if (typeof input === 'number') {
            return input;
        }
        if (typeof input === 'string') {
            const parsed = parseInt(input, 10);
            if (!isNaN(parsed)) {
                return parsed;
            }
        }
        if (typeof input === 'boolean') {
            return input ? 1 : 0;
        }
        throw new Error('Invalid input type');
    }
}
exports.Counter = Counter;
