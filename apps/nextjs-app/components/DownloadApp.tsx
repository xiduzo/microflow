'use client';

import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@microflow/ui';
import { useState } from 'react';

export function DownloadApp() {
	const [os, setOs] = useState('');

	function downloadApp() {
		const version = '0.3.0';
		const baseUrl = `https://github.com/xiduzo/microflow/releases/download/v${version}`;

		switch (os) {
			case 'macos':
				window.open(`${baseUrl}/Microflow.studio-${version}-arm64.dmg`);
				break;
			case 'windows':
				window.open(`${baseUrl}/Microflow.studio-${version}.Setup.exe`);
				break;
			case 'debian':
				window.open(`${baseUrl}/microflow-studio_${version}_amd64.deb`);
				break;
			case 'redhat':
				window.open(`${baseUrl}/microflow-studio-${version}-1.x86_64.rpm`);
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
