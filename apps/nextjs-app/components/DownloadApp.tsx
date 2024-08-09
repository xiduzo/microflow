'use client';

import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@fhb/ui';
import { useState } from 'react';

export function DownloadApp() {
	const [os, setOs] = useState('');

	function downloadApp() {
		switch (os) {
			case 'macos':
				window.open(
					'https://github.com/xiduzo/microflow-studio/releases/download/v0.1.0/microflow-studio-darwin-arm64-0.1.0.zip',
				);
				break;
			case 'windows':
				window.open(
					'https://github.com/xiduzo/microflow-studio/releases/download/v0.1.0/microflow-studio-0.1.0.Setup.exe',
				);
				break;
			case 'debian':
				window.open(
					'https://github.com/xiduzo/microflow-studio/releases/download/v0.1.0/microflow-studio_0.1.0_amd64.deb',
				);
				break;
			case 'redhat':
				window.open(
					'https://github.com/xiduzo/microflow-studio/releases/download/v0.1.0/microflow-studio-0.1.0-1.x86_64.rpm',
				);
				break;
		}
	}

	return (
		<section className="max-w-lg m-auto mt-6 flex flex-col md:flex-row items-center md:gap-x-8 gap-y-8 md:gap-y-0">
			<Select onValueChange={setOs}>
				<SelectTrigger>
					<SelectValue placeholder="select your operating system" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="macos">MacOS</SelectItem>
					<SelectItem value="windows">Windows</SelectItem>
					<SelectItem value="debian">Debian</SelectItem>
					<SelectItem value="redhat">RedHat</SelectItem>
				</SelectContent>
			</Select>
			<Button onClick={downloadApp} disabled={!os}>
				Download Microflow studio {os && ` for ${os}`}
			</Button>
		</section>
	);
}
