import { Button, Icons } from '@fhb/ui';
import { Edge, Node, useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { useNodesEdgesStore } from '../../../store';

export function SaveButton() {
	const [disabled, setDisabled] = useState(false);
	const { getNodes, getEdges } = useReactFlow();
	const { setNodes, setEdges } = useNodesEdgesStore();
	const [localNodes, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [localEdges, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);

	function handleClick() {
		setDisabled(true);

		setLocalNodes(
			getNodes().map(node => {
				node.data.value = undefined;
				node.selected = false;
				return node;
			}),
		);

		setLocalEdges(
			getEdges().map(edge => {
				edge.selected = false;
				edge.animated = false;
				return edge;
			}),
		);

		setDisabled(false);
	}

	useEffect(() => {
		setNodes(localNodes);
		setEdges(localEdges);
	}, [setNodes, localNodes, setEdges, localEdges]);

	return (
		<Button onClick={handleClick} variant="ghost" disabled={disabled}>
			{disabled ? <Icons.Loader2 className="animate-spin" /> : <Icons.Save />}
		</Button>
	);
}
