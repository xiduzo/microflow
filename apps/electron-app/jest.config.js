/**
 * @type {import('jest').Config}
 */
export default {
	preset: 'ts-jest',
	testEnvironment: 'node',
	setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
