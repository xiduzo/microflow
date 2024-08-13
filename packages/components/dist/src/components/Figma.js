"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Figma = void 0;
const BaseComponent_1 = require("./BaseComponent");
class Figma extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.defaultRGBA = { r: 0, g: 0, b: 0, a: 0 };
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
        this.value = value;
    }
    setExternal(value) {
        this.value = value;
    }
    red(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { r: Math.min(1, value / 255) });
    }
    green(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { g: Math.min(1, value / 255) });
    }
    blue(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { b: Math.min(1, value / 255) });
    }
    opacity(value) {
        const currentValue = typeof this.value === 'object' ? this.value : {};
        this.value = Object.assign(Object.assign(Object.assign({}, this.defaultRGBA), currentValue), { a: Math.min(1, value / 100) });
    }
}
exports.Figma = Figma;
