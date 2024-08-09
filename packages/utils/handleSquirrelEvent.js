const { spawn } = require('child_process');
const path = require('path');

const { app } = require('electron');

// https://github.com/electron/windows-installer#handling-squirrel-events
const handleSquirrelEvent = () => {
	if (process.argv.length === 1) {
		return false;
	}

	const appFolder = path.resolve(process.execPath, '..');
	const rootAtomFolder = path.resolve(appFolder, '..');
	const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
	// https://github.com/mongodb-js/electron-squirrel-startup/issues/30#issuecomment-567027284
	const exeName = process.execPath;

	const spawnProcess = (command, args) => {
		let spawnedProcess;

		try {
			spawnedProcess = spawn(command, args, { detached: true });
		} catch (reason) {
			// eslint-disable-next-line no-console
			console.error(reason);
		}

		return spawnedProcess;
	};

	const spawnUpdate = args => {
		return spawnProcess(updateDotExe, args);
	};

	const [, squirrelEvent] = process.argv;
	if (
		squirrelEvent === '--squirrel-install' ||
		squirrelEvent === '--squirrel-updated'
	) {
		spawnUpdate(['--createShortcut', exeName]);
		// eslint-disable-next-line @typescript-eslint/unbound-method
		setTimeout(app.quit, 1000);
		return true;
	}
	if (squirrelEvent === '--squirrel-uninstall') {
		spawnUpdate(['--removeShortcut', exeName]);
		// eslint-disable-next-line @typescript-eslint/unbound-method
		setTimeout(app.quit, 1000);
		return true;
	}
	if (squirrelEvent === '--squirrel-obsolete') {
		app.quit();
		return true;
	}
	return false;
};

export default handleSquirrelEvent;
