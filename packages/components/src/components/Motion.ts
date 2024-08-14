import JohnnyFive from 'johnny-five';
import { BaseComponent, BaseComponentOptions } from './BaseComponent';

type MotionOptions = BaseComponentOptions<boolean> & JohnnyFive.MotionOption;

export class Motion extends BaseComponent<boolean> {
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
