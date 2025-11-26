import { Code } from '../base';
import type { Data, Value } from './constant.types';
import { dataSchema } from './constant.types';

export class Constant extends Code<Value, Data> {
	constructor(data: Data) {
		super(dataSchema.parse(data), data.value);
	}
}
