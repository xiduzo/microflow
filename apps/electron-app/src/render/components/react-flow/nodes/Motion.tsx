import type { MotionData, MotionValueType } from '@microflow/components';
import { MOTION_CONTROLLERS } from '@microflow/components/contants';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect } from 'react';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { BindingApi } from '@tweakpane/core';
import { usePins } from '../../../stores/board';

export function Motion(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle
				type="source"
				position={Position.Right}
				id="motionstart"
				title="Motion started"
				offset={-0.5}
			/>
			<Handle
				type="source"
				position={Position.Right}
				id="motionend"
				title="Motion ended"
				offset={0.5}
			/>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<MotionValueType>(id, false);

	if (!value) return <Icons.EyeClosed className="text-muted-foreground" size={48} />;
	return <Icons.Eye className="text-green-500" size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<MotionData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		let pinBinding: BindingApi | undefined;

		function createPinPane() {
			pinBinding?.dispose();

			pinBinding = pane.addBinding(settings, 'pin', {
				view: 'list',
				disabled: !pins.length,
				label: 'pin',
				index: 1,
				options: pins
					.filter(pin => {
						const isCorrectMode =
							pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.I2C);

						if (settings.controller === 'HCSR501') {
							return isCorrectMode && pin.supportedModes.includes(MODES.ANALOG);
						} else {
							return isCorrectMode && !pin.supportedModes.includes(MODES.ANALOG);
						}
					})
					.map(mapPinToPaneOption),
			});
		}

		const controllerBinding = pane
			.addBinding(settings, 'controller', {
				view: 'list',
				index: 0,
				options: MOTION_CONTROLLERS.map(controller => ({
					value: controller,
					text: controller,
				})),
			})
			.on('change', createPinPane);

		createPinPane();

		return () => {
			[pinBinding, controllerBinding].forEach(disposable => disposable?.dispose());
		};
	}, [pane, pins]);

	return null;
}

type Props = BaseNode<MotionData, MotionValueType>;
export const DEFAULT_MOTION_DATA: Props['data'] = {
	pin: '8',
	label: 'Motion',
	controller: 'HCSR501',
};
