export function KbdAccelerator() {
	if (window.electron.os.isMac) {
		return '⌘';
	}
	if (window.electron.os.isWindows) {
		return 'Ctrl';
	}
	if (window.electron.os.isLinux) {
		return 'Ctrl';
	}
	return '';
}
