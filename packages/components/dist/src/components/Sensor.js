"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sensor = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Sensor extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Sensor(options);
        this.component.on('change', () => {
            this.value = Number(this.component.raw);
        });
    }
}
exports.Sensor = Sensor;
