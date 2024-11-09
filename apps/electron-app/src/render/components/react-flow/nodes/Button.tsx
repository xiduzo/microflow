import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Icons, Toggle } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { pinValue } from '../../../../utils/pin';
import { useBoard } from '../../../providers/BoardProvider';
import { Handle } from './Handle';
import {
  BaseNode,
  NodeContainer,
  NodeContent,
  NodeValue,
  useNodeSettingsPane
} from './Node';

export function Button(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue>
					<Toggle
						disabled
						className="opacity-100 disabled:opacity-100"
						size="lg"
						pressed={Boolean(props.data.value)}
					>
						{Boolean(props.data.value) && <Icons.Pointer />}
						{!Boolean(props.data.value) && <Icons.PointerOff className="text-muted-foreground" />}
					</Toggle>
				</NodeValue>
			</NodeContent>
			<SettingsPane />
			<Handle type="source" position={Position.Right} id="active" offset={-1} />
			<Handle type="source" position={Position.Right} id="hold" />
			<Handle type="source" position={Position.Right} id="inactive" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function SettingsPane() {
  const { pane, settings, updateNode } = useNodeSettingsPane()
  const { pins } = useBoard()

  useEffect(() => {
    if(!pane) return

    pane.addBinding(settings, 'pin', {
      view: 'list',
      disabled: !pins.length,
      label: "pin",
      options: pins.filter(pin => pin.supportedModes.includes(MODES.INPUT)).map(pin => ({
        value: pinValue(pin),
        text: `${pinValue(pin)}`,
      }))
    })

    const advanced = pane.addFolder({
      title: "advanced",
      expanded: false
    })

    advanced.addBinding(settings, 'holdtime', {
      min: 100,
      step: 50,
    });

    const type = advanced.addBlade({
      view: 'list',
      label: 'type',
      value: settings.isPulldown ? 'pulldown' : settings.isPullup ? 'pullup' : 'default',
      options: [
        { value: 'default', text: 'default' },
        { value: 'pullup', text: 'pull-up' },
        { value: 'pulldown', text: 'pull-down' },
      ],
    })

    advanced.addBinding(settings, 'invert')

    pane.addButton({
      title: 'Save',
    }).on('click', () => {
      switch(type.exportState().value) {
        case 'default':
          settings.isPullup = false
          settings.isPulldown = false
          break
        case 'pullup':
          settings.isPullup = true
          settings.isPulldown = false
          break
        case 'pulldown':
          settings.isPullup = false
          settings.isPulldown = true
          break
      }

      updateNode(settings)
    })
  }, [pane, settings, updateNode, pins])

  return null
}

type Props = BaseNode<ButtonData, ButtonValueType>;
export const DEFAULT_BUTTON_DATA: Props['data'] = {
	value: false,
	holdtime: 500,
	isPulldown: false,
	isPullup: false,
	invert: false,
	pin: 6,
	label: 'Button',
};
