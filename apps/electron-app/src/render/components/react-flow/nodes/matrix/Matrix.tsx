import { Icons } from '@ui/index';
import { Position } from '@xyflow/react';
import { Led } from 'johnny-five';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from '../Node';
import { MatrixEditor } from './MatrixEditor';

export function Matrix(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					<Icons.Antenna className="w-8 h-8" />
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<MatrixEditor dimensions={props.data.dims} />
			</NodeSettings>
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

export type MatrixData = Omit<
	Led.MatrixOption & Led.MatrixIC2Option,
	'board'
> & {};

type Props = BaseNode<MatrixData, any>;
export const DEFAULT_MATRIX_DATA: Props['data'] = {
	value: false,
	label: 'Matrix',
	pins: {
		data: 8,
		clock: 10,
		cs: 4,
	},
	controller: undefined,
	dims: [8, 8],
};
