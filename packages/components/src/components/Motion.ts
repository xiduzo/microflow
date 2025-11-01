import JohnnyFive, { MotionOption } from 'johnny-five';
import { Controller } from '../constants/Motion';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type MotionData = Omit<MotionOption, 'board'> & {
	controller: Controller;
};
export type MotionValueType = boolean;
export type { Controller } from '../constants/Motion';

export class Motion extends BaseComponent<MotionValueType, MotionData> {
	private readonly component: JohnnyFive.Motion;

	constructor(data: BaseComponentData & MotionData) {
		super(data, false);

		this.component = new JohnnyFive.Motion(data);

		this.component.on('motionstart', () => {
			this.eventEmitter.emit('motionstart');
		});

		this.component.on('motionend', () => {
			this.eventEmitter.emit('motionend');
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
