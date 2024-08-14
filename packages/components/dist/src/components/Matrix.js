"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Matrix = void 0;
const node_1 = __importDefault(require("electron-log/node"));
const johnny_five_1 = require("johnny-five");
const BaseComponent_1 = require("./BaseComponent");
class Matrix extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.controller = new johnny_five_1.Led.Matrix(options);
        node_1.default.debug('Matrix created', options);
        this.controller.brightness(100);
        this.controller.off();
    }
    draw() { }
}
exports.Matrix = Matrix;
