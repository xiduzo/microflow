import JohnnyFive, { MotionOption } from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

export const MOTION_CONTROLLERS = [
	'HCSR501',
	'GP2Y0D810Z0F',
	'GP2Y0D815Z0F',
] as const;
export type Controller = (typeof MOTION_CONTROLLERS)[number];

export type MotionData = Omit<MotionOption, 'board'> & {
	controller: Controller;
};
export type MotionValueType = boolean;

type MotionOptions = BaseComponentOptions & MotionData;

export class Motion extends BaseComponent<MotionValueType> {
	private readonly component: JohnnyFive.Motion;

	constructor(private readonly options: MotionOptions) {
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
