import { BaseComponent, BaseComponentData } from './BaseComponent';

export type ConstantValueType = number;

export type ConstantData = {
	value: number;
};

export class Constant extends BaseComponent<ConstantValueType> {
	constructor(data: BaseComponentData & ConstantData) {
		super(data, data.value);
	}
}
