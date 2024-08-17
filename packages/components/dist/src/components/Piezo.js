"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Piezo = void 0;
const johnny_five_1 = __importDefault(require("johnny-five"));
const BaseComponent_1 = require("./BaseComponent");
class Piezo extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.component = new johnny_five_1.default.Piezo(options);
    }
    buzz() {
        this.stop();
        if (this.options.type !== 'buzz') {
            return;
        }
        this.value = true;
        this.component.frequency(this.options.frequency, this.options.duration);
        setTimeout(() => {
            this.stop();
        }, this.options.duration);
    }
    stop() {
        this.component.stop();
        this.component.off();
        this.value = false;
        return this;
    }
    play() {
        this.stop();
        if (this.options.type !== 'song') {
            return;
        }
        this.value = true;
        this.component.play({
            song: this.options.song,
            tempo: this.options.tempo,
        }, () => {
            this.value = false;
        });
        return this;
    }
}
exports.Piezo = Piezo;
