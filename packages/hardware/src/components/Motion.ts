import JohnnyFive, { MotionOption } from 'johnny-five';
import { Controller } from '../constants/Motion';
import { Hardware, BaseComponentData } from './BaseComponent';

export type MotionData = Omit<MotionOption, 'board'> & {
	controller: Controller;
};
export type MotionValueType = boolean;
export type { Controller } from '../constants/Motion';

export class Motion extends Hardware<MotionValueType, MotionData, JohnnyFive.Motion> {
	constructor(data: BaseComponentData & MotionData) {
		super(data, false);
	}

	protected createComponent(data: BaseComponentData & MotionData) {
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
		return this.component;
	}
}
