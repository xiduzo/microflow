"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Motion = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Motion extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Motion(options);
        this.component.on('motionstart', () => {
            this.eventEmitter.emit('motionstart');
        });
        this.component.on('motionend', () => {
            this.eventEmitter.emit('motionend');
        });
        this.component.on('data', data => {
            const { detectedMotion, isCalibrated } = data;
            if (!isCalibrated)
                return;
            this.value = detectedMotion;
        });
    }
}
exports.Motion = Motion;
