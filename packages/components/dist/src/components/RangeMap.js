"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RangeMap = void 0;
const BaseComponent_1 = require("./BaseComponent");
class RangeMap extends BaseComponent_1.BaseComponent {
    constructor(options) {
        super(options);
        this.options = options;
        this.eventEmitter.on('to', this.postMessage.bind(this, 'to'));
    }
    from(input) {
        if (typeof input === 'boolean') {
            input = input ? 1 : 0;
        }
        if (typeof input === 'string') {
            input = parseFloat(input);
        }
        const [inMin = 0, inMax = 1023] = this.options.from;
        const [outMin = 0, outMax = 1023] = this.options.to;
        const mapped = ((input - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
        const distance = outMax - outMin;
        const normalizedOutput = parseFloat(mapped.toFixed(distance <= 10 ? 1 : 0));
        const prevValue = this.value;
        this.value = [input, normalizedOutput];
        if (prevValue[1] !== normalizedOutput) {
            this.eventEmitter.emit('to', normalizedOutput);
        }
    }
}
exports.RangeMap = RangeMap;
