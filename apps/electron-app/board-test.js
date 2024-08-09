const JohnnyFive = require('johnny-five');
const log = require('electron-log/node');
const EventEmitter = require('events');

const board = new JohnnyFive.Board({
	repl: true,
});

board.on('ready', () => {
	const piezo = new Piezo({ pin: 11 });

	board.repl.inject({
		// Allow limited on/off control access to the
		// Led instance from the REPL.
		freq: (frequency = 420, duration = 1000) => {
			piezo.frequency(frequency, duration);
		},
		play: () => {
			piezo.play({
				// song is composed by an array of pairs of notes and beats
				// The first argument is the note (null means "no note")
				// The second argument is the length of time (beat) of the note (or non-note)
				song: [
					['C4', 1 / 4],
					['D4', 1 / 4],
					['F4', 1 / 4],
					['D4', 1 / 4],
					['A4', 1 / 4],
					[null, 1 / 4],
					['A4', 1],
					['G4', 1],
					[null, 1 / 2],
					['C4', 1 / 4],
					['D4', 1 / 4],
					['F4', 1 / 4],
					['D4', 1 / 4],
					['G4', 1 / 4],
					[null, 1 / 4],
					['G4', 1],
					['F4', 1],
					[null, 1 / 2],
				],
				tempo: 100,
			});
		},
	});
});

class Piezo extends JohnnyFive.Piezo {
	#eventEmitter = new EventEmitter();
	#timeout = null;

	constructor(options) {
		super(options);
		this.options = options;
	}

	stop() {
		super.stop();
		super.off();
	}

	buzz() {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
		}

		this.stop();

		super.frequency(this.options.frequency, this.options.duration);

		this.#timeout = setTimeout(() => {
			this.stop();
		}, this.options.duration);
	}

	play() {
		//super.play(this.options.song);
		console.log('play', this.options);
		this.stop();
		super.play({
			beats: 20,
			// song is composed by an array of pairs of notes and beats
			// The first argument is the note (null means "no note")
			// The second argument is the length of time (beat) of the note (or non-note)
			song: [
				['C4', 1 / 4],
				['D4', 1 / 4],
				['F4', 1 / 4],
				['D4', 1 / 4],
				['A4', 1 / 4],
				[null, 1 / 4],
				['A4', 1],
				['G4', 1],
				[null, 1 / 2],
				['C4', 1 / 4],
				['D4', 1 / 4],
				['F4', 1 / 4],
				['D4', 1 / 4],
				['G4', 1 / 4],
				[null, 1 / 4],
				['G4', 1],
				['F4', 1],
				[null, 1 / 2],
			],
			tempo: this.options.tempo,
		});
	}

	postMessage(action) {
		if (action !== 'change') {
			this.#eventEmitter.emit('change', this.value);
		}

		process.parentPort.postMessage({
			nodeId: this.options.id,
			action,
			value: this.value,
		});
	}
}
