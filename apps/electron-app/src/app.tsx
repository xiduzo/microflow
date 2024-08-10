import { FigmaProvider, MqttConfig, MqttProvider } from '@fhb/mqtt/client';
import { Edge, Node, ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
	adjectives,
	animals,
	uniqueNamesGenerator,
} from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { ReactFlowCanvas } from './render/components/react-flow/ReactFlowCanvas';
import { useSignalNodesAndEdges } from './render/hooks/useSignalNodesAndEdges';
import { BoardProvider } from './render/providers/BoardProvider';
import { NewNodeProvider } from './render/providers/NewNodeProvider';
import { useNodesEdgesStore } from './render/store';

export function App() {
	const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig | undefined>(
		'mqtt-config',
		{
			uniqueId: '',
		},
	);

	// Somehow initial triggers engless rerenders
	// This is a workaround
	useEffect(() => {
		if (mqttConfig.uniqueId.length) {
			return;
		}

		setMqttConfig({
			uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
		});
	}, [mqttConfig.uniqueId]);

	return (
		<MqttProvider appName="app" config={mqttConfig}>
			<FigmaProvider>
				<BoardProvider>
					<ReactFlowProvider>
						<NodeAndEdgeSignaler />
						<LoadNodesAndEdges />
						<NewNodeProvider>
							<ReactFlowCanvas />
						</NewNodeProvider>
					</ReactFlowProvider>
				</BoardProvider>
			</FigmaProvider>
		</MqttProvider>
	);
}

const root = createRoot(document.body.querySelector('main'));
root.render(<App />);

function NodeAndEdgeSignaler() {
	useSignalNodesAndEdges();

	return null;
}

function LoadNodesAndEdges() {
	const [localNodes] = useLocalStorage<Node[]>('nodes', []);
	const [localEdges] = useLocalStorage<Edge[]>('edges', []);
	const { setNodes, setEdges } = useNodesEdgesStore();

	useEffect(() => {
		setNodes(localNodes);
		setEdges(localEdges);
	}, [setNodes, localNodes, setEdges, localEdges]);

	return null;
}
