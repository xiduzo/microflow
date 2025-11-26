import JohnnyFive from 'johnny-five';
import { Hardware } from '../base';
import type { Data, Value } from './motion.types';
import { dataSchema } from './motion.types';

export class Motion extends Hardware<Value, Data, JohnnyFive.Motion> {
	constructor(data: Data) {
		super(dataSchema.parse(data), false);
	}

	protected createComponent(data: Data) {
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
