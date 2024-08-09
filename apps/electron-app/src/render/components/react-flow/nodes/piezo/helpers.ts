import { NOTE_DURATION } from './constants';

export function noteDurationToVisualDuation(duration: number) {
	switch (duration) {
		case NOTE_DURATION.DoubleWhole:
			return '2';
		case NOTE_DURATION.Whole:
			return '1';
		case NOTE_DURATION.Half:
			return '1/2';
		case NOTE_DURATION.Quarter:
			return '1/4';
		case NOTE_DURATION.Eighth:
			return '1/8';
		case NOTE_DURATION.Sixteenth:
			return '1/16';
	}
}
