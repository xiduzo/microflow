"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interval = void 0;
const BaseComponent_1 = require("./BaseComponent");
class Interval extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.minIntervalInMs = 500;
        this.interval = null;
        this.start();
    }
    getIntervalTime(interval) {
        const parsed = parseInt(String(interval));
        const isNumber = !isNaN(parsed);
        if (!isNumber) {
            return this.minIntervalInMs;
        }
        return Math.max(this.minIntervalInMs, parsed);
    }
    start() {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.interval = setInterval(() => {
            this.value = Math.round(performance.now());
        }, this.getIntervalTime(this.options.interval));
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }
}
exports.Interval = Interval;
