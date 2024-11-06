import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Label, Pane, Slider } from '@microflow/ui';
import { BladeState } from '@tweakpane/core';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { useUpdateNode } from '../../../hooks/nodeUpdater';
import { Handle } from './Handle';
import {
  BaseNode,
  NodeContainer,
  NodeContent,
  NodeValue,
  useNode,
  useNodeSettings
} from './Node';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					{numberFormat.format(Math.round(props.data.value))}
				</NodeValue>
			</NodeContent>
			<IntervalSettingsPane {...props.data} id={props.id} />
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function IntervalSettingsPane(props: Props['data'] & { id: Props['id']}) {
  const { settingsOpened, data, id } = useNode()
  const updateNode = useUpdateNode(id);

  useEffect(() => {
    if(!settingsOpened) return
    const pane = new Pane({
      title: `${props.label} (${props.id})`
    })

    const PARAMS = {
      interval: props.interval,
    };

    pane.addBinding(PARAMS, 'interval', {
      min: 0,
      max: 5000,
      step: 100
    });

    const btn = pane.addButton({
      title: 'Save',
    });

    btn.on('click', () => {
      const obj = Object.entries(pane.exportState()).reduce((acc, [key, value]) => {
        if(key !== 'children') return acc

        const bladeStates = value as BladeState[]
        bladeStates.forEach(state => {
          if(!state.binding) return
          acc[(state.binding as any).key as string] = (state.binding as any).value
        })

        return acc
      }, {} as Record<string, unknown>)
      updateNode(obj)
    })

    return () => {
      pane.dispose()
    }
  }, [settingsOpened, data])

  return null
}

function IntervalSettings() {
	const { settings, setSettings } = useNodeSettings<IntervalData>();

	return (
		<>
			<Label htmlFor="interval" className="flex justify-between">
				Interval
				<span className="opacity-40 font-light">{settings.interval}ms</span>
			</Label>
			<Slider
				id="interval"
				className="pb-2"
				defaultValue={[settings.interval]}
				min={500}
				max={5000}
				step={100}
				onValueChange={value => setSettings({ interval: value[0] })}
			/>
		</>
	);
}

type Props = BaseNode<IntervalData, IntervalValueType>;
export const DEFAULT_INTERVAL_DATA: Props['data'] = {
	label: 'Interval',
	interval: 500,
	value: 0,
};
