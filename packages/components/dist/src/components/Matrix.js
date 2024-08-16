"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Matrix = void 0;
const johnny_five_1 = require("johnny-five");
const BaseComponent_1 = require("./BaseComponent");
class Matrix extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.controller = new johnny_five_1.Led.Matrix(options);
        this.controller.brightness(100);
        this.controller.off();
    }
    show(index) {
        this.controller.on();
        const shape = this.options.shapes[index];
        if (!shape) {
            return;
        }
        this.controller.draw(0, shape);
        this.value = shape;
    }
    hide() {
        this.controller.off();
        this.value = this.value.map(row => row.replace(/'1'/g, '0'));
    }
}
exports.Matrix = Matrix;
