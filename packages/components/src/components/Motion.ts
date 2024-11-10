import JohnnyFive, { MotionOption } from 'johnny-five';
import { Controller } from '../constants/Motion';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export type MotionData = Omit<MotionOption, 'board'> & {
	controller: Controller;
};
export type MotionValueType = boolean;
export type { Controller } from '../constants/Motion';

type MotionOptions = BaseComponentOptions & MotionData;

export class Motion extends BaseComponent<MotionValueType> {
	private readonly component: JohnnyFive.Motion;

	constructor(options: MotionOptions) {
		super(options);

		this.component = new JohnnyFive.Motion(options);

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
