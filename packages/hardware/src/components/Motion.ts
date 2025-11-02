import JohnnyFive, { MotionOption } from 'johnny-five';
import { Controller } from '../constants/Motion';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type MotionData = Omit<MotionOption, 'board'> & {
	controller: Controller;
};
export type MotionValueType = boolean;
export type { Controller } from '../constants/Motion';

export class Motion extends BaseComponent<MotionValueType, MotionData, JohnnyFive.Motion> {
	constructor(data: BaseComponentData & MotionData) {
		super(data, false);

		this.createComponent(data);
		this.on('new-data', data => this.createComponent(data as BaseComponentData & MotionData));
	}

	private createComponent(data: BaseComponentData & MotionData) {
		this.component = new JohnnyFive.Motion(data);

		this.component.on('motionstart', () => {
			this.emit('motionstart');
		});

		this.component.on('motionend', () => {
			this.emit('motionend');
		});

		this.component.on('data', data => {
			const { detectedMotion, isCalibrated } = data as {
				timestamp: number;
				detectedMotion: boolean;
				isCalibrated: boolean;
			};
			if (!isCalibrated) return;
			this.value = detectedMotion;
		});
	}
}
