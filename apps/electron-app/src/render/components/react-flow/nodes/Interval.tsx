import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { useUpdateNode } from '../../../hooks/nodeUpdater';
import { Handle } from './Handle';
import {
    BaseNode,
    NodeContainer,
    NodeContent,
    NodeValue,
    useNode,
    useNodeSettingsPane
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
			<SettingsPane />
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function SettingsPane() {
  const { pane } = useNodeSettingsPane()
  const { data, id } = useNode<IntervalData>()
  const paneData = useRef(data)
  const updateNode = useUpdateNode(id);

  useEffect(() => {
    if(!pane) return

    pane.addBinding(paneData.current, 'interval', {
      min: 500,
      max: 5000,
      step: 100
    });

    pane.addButton({
      title: 'Save',
    }).on('click', (e) => {
      console.log(paneData.current)
      updateNode(paneData.current)
    })
  }, [pane])

  return null
}

type Props = BaseNode<IntervalData, IntervalValueType>;
export const DEFAULT_INTERVAL_DATA: Props['data'] = {
	label: 'Interval',
	interval: 500,
	value: 0,
};
