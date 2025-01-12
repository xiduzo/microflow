import { useEffect } from 'react';

type Options = {
	code: KeyCode;
	withMetaKey?: boolean;
	withShiftKey?: boolean;
	withAltKey?: boolean;
	isCorrectTarget?: (target: HTMLElement) => boolean;
	/*
	 * When `undefined`, the default behavior is to prevent the default action.
	 */
	preventDefault?: boolean;
};

type Action = (event: KeyboardEvent) => void;

function checkKey(isPressed: boolean, shouldBePressed?: boolean) {
	if (shouldBePressed === undefined && !isPressed) return true;
	if (!shouldBePressed && !isPressed) return true;
	if (shouldBePressed && isPressed) return true;

	return false;
}

export function useHotkey(options: Options, action: Action) {
	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.code !== options.code) return;
			const checkMeta = checkKey(event.metaKey, options.withMetaKey);
			const checkShift = checkKey(event.shiftKey, options.withShiftKey);
			const checkAlt = checkKey(event.altKey, options.withAltKey);
			if (!checkMeta || !checkShift || !checkAlt) return;
			if (options.isCorrectTarget && !options.isCorrectTarget(event.target as HTMLElement)) return;

			if (options.preventDefault === undefined) {
				event.preventDefault();
			}

			action(event);
		}

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [options, action]);
}

type KeyCode =
	| 'Backspace'
	| 'Tab'
	| 'Enter'
	| 'ShiftLeft'
	| 'ShiftRight'
	| 'ControlLeft'
	| 'ControlRight'
	| 'AltLeft'
	| 'AltRight'
	| 'Pause'
	| 'CapsLock'
	| 'Escape'
	| 'Space'
	| 'PageUp'
	| 'PageDown'
	| 'End'
	| 'Home'
	| 'ArrowLeft'
	| 'ArrowUp'
	| 'ArrowRight'
	| 'ArrowDown'
	| 'PrintScreen'
	| 'Insert'
	| 'Delete'
	| 'Digit0'
	| 'Digit1'
	| 'Digit2'
	| 'Digit3'
	| 'Digit4'
	| 'Digit5'
	| 'Digit6'
	| 'Digit7'
	| 'Digit8'
	| 'Digit9'
	| 'KeyA'
	| 'KeyB'
	| 'KeyC'
	| 'KeyD'
	| 'KeyE'
	| 'KeyF'
	| 'KeyG'
	| 'KeyH'
	| 'KeyI'
	| 'KeyJ'
	| 'KeyK'
	| 'KeyL'
	| 'KeyM'
	| 'KeyN'
	| 'KeyO'
	| 'KeyP'
	| 'KeyQ'
	| 'KeyR'
	| 'KeyS'
	| 'KeyT'
	| 'KeyU'
	| 'KeyV'
	| 'KeyW'
	| 'KeyX'
	| 'KeyY'
	| 'KeyZ'
	| 'MetaLeft'
	| 'MetaRight'
	| 'ContextMenu'
	| 'Numpad0'
	| 'Numpad1'
	| 'Numpad2'
	| 'Numpad3'
	| 'Numpad4'
	| 'Numpad5'
	| 'Numpad6'
	| 'Numpad7'
	| 'Numpad8'
	| 'Numpad9'
	| 'NumpadMultiply'
	| 'NumpadAdd'
	| 'NumpadSubtract'
	| 'NumpadDecimal'
	| 'NumpadDivide'
	| 'F1'
	| 'F2'
	| 'F3'
	| 'F4'
	| 'F5'
	| 'F6'
	| 'F7'
	| 'F8'
	| 'F9'
	| 'F10'
	| 'F11'
	| 'F12'
	| 'NumLock'
	| 'ScrollLock'
	| 'Semicolon'
	| 'Equal'
	| 'Comma'
	| 'Minus'
	| 'Period'
	| 'Slash'
	| 'Backquote'
	| 'BracketLeft'
	| 'Backslash'
	| 'BracketRight'
	| 'Quote';
