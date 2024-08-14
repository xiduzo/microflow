"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Figma = void 0;
const node_1 = __importDefault(require("electron-log/node"));
const BaseComponent_1 = require("./BaseComponent");
class Figma extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.defaultRGBA = { r: 0, g: 0, b: 0, a: 1 };
    }
    increment(amount = 1) {
        this.value = Number(this.value) + amount;
    }
    decrement(amount = 1) {
        this.value = Number(this.value) - amount;
    }
    true() {
        this.value = true;
    }
    false() {
        this.value = false;
    }
    toggle() {
        this.value = !Boolean(this.value);
    }
    set(value) {
        try {
            switch (typeof this.value) {
                case 'string':
                    this.value = String(value !== null && value !== void 0 ? value : '-');
                    break;
                case 'number':
                    const num = Number(value);
                    if (isNaN(num)) {
                        throw new Error('Invalid number');
                    }
                    this.value = this.formatNumberWithMaxDecimals(num);
                    break;
                case 'boolean':
                    this.value = Boolean(value);
                    break;
                case 'object':
                    const convertedValue = this.convertValue(value);
                    if (typeof convertedValue !== 'object') {
                        throw new Error('Invalid object');
                    }
                    this.value = convertedValue;
                    break;
            }
        }
        catch (error) {
            node_1.default.warn('Invalid value type to set figma', { value, error });
            this.postErrorMessage('set', new Error(`${value} is not a valid value`));
        }
    }
    setExternal(value) {
        this.value = this.convertValue(value);
    }
    red(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { r: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)) });
    }
    green(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { g: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)) });
    }
    blue(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { b: this.formatNumberWithMaxDecimals(Math.min(1, value / 255)) });
    }
    opacity(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { a: this.formatNumberWithMaxDecimals(Math.min(1, value / 100)) });
    }
    formatNumberWithMaxDecimals(value) {
        return Number(value.toFixed(2));
    }
    convertValue(value) {
        if (typeof value === 'object') {
            const obj = Object.assign(Object.assign({}, this.defaultRGBA), value);
            return {
                r: this.formatNumberWithMaxDecimals(obj.r),
                g: this.formatNumberWithMaxDecimals(obj.g),
                b: this.formatNumberWithMaxDecimals(obj.b),
                a: this.formatNumberWithMaxDecimals(obj.a),
            };
        }
        if (typeof value === 'number') {
            return this.formatNumberWithMaxDecimals(value);
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            return value !== null && value !== void 0 ? value : '-';
        }
        throw new Error('Invalid value type');
    }
}
exports.Figma = Figma;
