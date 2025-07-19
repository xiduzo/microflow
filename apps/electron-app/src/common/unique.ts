import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';

export function getRandomUniqueUserName() {
	return uniqueNamesGenerator({ dictionaries: [adjectives, animals] });
}
