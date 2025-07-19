const waitMessages = [
	'Hang tight, almost there!',
	'Just a moment, working on it!',
	'Getting things sorted!',
	'Hold on, making progress!',
	'Almost there, just a little longer!',
	'Stay tight, fixing it up!',
	'One moment, on it!',
	"Don't worry, nearly done!",
	'Please wait, resolving the issue!',
	'Sit tight, handling it!',
	'Almost there!',
	'Hold tight, getting things back on track!',
	'Just a bit longer, working through it!',
	'Nearly finished!',
	'Hang in there, sorting it out!',
	'On it, just a few more moments!',
	'Stay tuned, fixing things up!',
	'Almost done!',
	'Nearly there!',
	'Please hold on, resolving the issue!',
	'Just a little bit longer!',
	'Getting close!',
	'Hold tight, nearly there!',
	'Just a moment more,working on it!',
	'Almost through!',
	'On the case, just a bit longer!',
	'Please hold on, fixing things up!',
	'Just a moment, getting things back on track!',
	'Stay tuned, handling it!',
	'Just a bit longer, resolving the issue!',
];

const actionLabels = [
	'Roger that',
	'Got it',
	'Understood',
	'Copy that',
	'Affirmative',
	'Okay',
	'Will do',
	'On it',
	'Sure thing',
	'Absolutely',
	'Right away',
	'You got it',
];

export function getRandomMessage(type: 'wait' | 'action') {
	switch (type) {
		case 'action':
			return actionLabels[Math.floor(Math.random() * actionLabels.length)];
		case 'wait':
			return waitMessages[Math.floor(Math.random() * waitMessages.length)];
		default:
			throw new Error('Invalid message type');
	}
}
