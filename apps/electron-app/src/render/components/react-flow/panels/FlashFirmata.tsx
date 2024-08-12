import { Badge } from '@microflow/ui';
import { KnownBoard } from 'avrgirl-arduino';
import { useState } from 'react';
import { useBoard } from '../../../providers/BoardProvider';

const SUPPORTED_BOARDS: [KnownBoard, string][] = [
	['uno', 'Arduino uno'],
	['mega', 'Arduino mega'],
	['leonardo', 'Arduino leonardo'],
	['micro', 'Arduino micro'],
	['nano', 'Arduino nano'],
	['yun', 'Arduino yun'],
];

export function FlashFirmata(props: Props) {
	const { flashResult, flashBoard } = useBoard();

	const [boardToFlash, setBoardToFlash] = useState<
		KnownBoard[number] | undefined
	>();

	function flashFirmata() {
		if (!boardToFlash) return;

		flashBoard(boardToFlash as KnownBoard);
	}

	return (
		<section className="flex items-center space-x-2">
			<Badge variant={props.message ? 'destructive' : 'secondary'}>
				{props.message?.split('\n')[0].trim() ?? 'Unknown error occurred'}
			</Badge>
			{/* <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon">
            <Icons.ArrowBigRight className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload</DialogTitle>
            <DialogDescription>
              This action will remove any existing code on your device.
            </DialogDescription>
          </DialogHeader>
          <section className="flex flex-col space-y-4 justify-end">
            {flashResult.message && (
              <Alert variant="destructive" className="bg-red-100">
                <Icons.TerminalIcon className="h-4 w-4" />
                <AlertTitle>Flashing failed</AlertTitle>
                <AlertDescription>{flashResult.message}</AlertDescription>
              </Alert>
            )}
            <Select value={boardToFlash} onValueChange={setBoardToFlash}>
              <SelectTrigger>
                <SelectValue placeholder="Select your board" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Compatible boards</SelectLabel>
                  {SUPPORTED_BOARDS.map(([key, value]) => (
                    <SelectItem key={key} value={key}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              disabled={flashResult.type === "flashing" || !boardToFlash}
              onClick={flashFirmata}
            >
              Upload firmware
              {flashResult.type === "flashing" && (
                <Icons.LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
              )}
            </Button>
          </section>
        </DialogContent>
      </Dialog> */}
		</section>
	);
}

type Props = {
	message?: string;
};
