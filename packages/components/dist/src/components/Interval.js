"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interval = void 0;
const BaseComponent_1 = require("./BaseComponent");
class Interval extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.minIntervalInMs = 500;
        setInterval(() => {
            this.value = Math.round(performance.now());
        }, this.interval(options.interval));
    }
    interval(interval) {
        const parsed = parseInt(String(interval));
        const isNumber = !isNaN(parsed);
        if (!isNumber) {
            return this.minIntervalInMs;
        }
        return Math.max(this.minIntervalInMs, parsed);
    }
}
exports.Interval = Interval;
