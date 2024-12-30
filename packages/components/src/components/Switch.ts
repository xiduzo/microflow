import JohnnyFive, { SwitchOption } from 'johnny-five';
import { BaseComponent, BaseComponentData } from './BaseComponent';

export type SwitchValueType = boolean;
export type SwitchData = Omit<SwitchOption, 'board'>;

export class Switch extends BaseComponent<SwitchValueType> {
	private component: JohnnyFive.Switch;

	constructor(data: BaseComponentData & SwitchData) {
		super(data, false);

		this.component = new JohnnyFive.Switch(data);

		this.component.on('open', () => {
			this.value = true;
			this.eventEmitter.emit('open', this.value);
		});

		this.component.on('close', () => {
			this.value = false;
			this.eventEmitter.emit('close', this.value);
		});
	}
}

// TODO: when implementing a 3 pin on-off-on switch switch, check the following code.
// const switch1 = new Switch(2); // Switch component for ON1 terminal
//   const switch2 = new Switch(3); // Switch component for ON2 terminal

//   switch1.on("open", () => {
//     console.log("Switch is in OFF or ON2 position");
//   });

//   switch1.on("close", () => {
//     console.log("Switch is in ON1 position");
//   });

//   switch2.on("open", () => {
//     console.log("Switch is in OFF or ON1 position");
//   });

//   switch2.on("close", () => {
//     console.log("Switch is in ON2 position");
//   });

//   // Function to determine the exact position of the switch
//   const determineSwitchPosition = () => {
//     if (switch1.isClosed) {
//       console.log("Switch is in ON1 position");
//     } else if (switch2.isClosed) {
//       console.log("Switch is in ON2 position");
//     } else {
//       console.log("Switch is in OFF position");
//     }
//   };

//   // Check the switch position every 500ms
//   setInterval(determineSwitchPosition, 500);
