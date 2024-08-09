import {
	Button,
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
	Icons,
} from '@ui/index';
import { Edge, Node, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { useIsAppleProduct } from '../../../hooks/useIsAppleProduct';
import { MqttSettingsForm } from '../../forms/MqttSettingsForm';

export function MenuButton() {
	const [autoSave, setAutoSave] = useLocalStorage('autoSave', true);
	const [dropDownOpen, setDropdownOpen] = useState(false);
	const isAppleProduct = useIsAppleProduct();

	const { getNodes, getEdges } = useReactFlow();
	const [, setLocalNodes] = useLocalStorage<Node[]>('nodes', []);
	const [, setLocalEdges] = useLocalStorage<Edge[]>('edges', []);

	const closeDropdown = () => setDropdownOpen(false);

	const saveNodesAndEdges = useCallback(
		(autoSafe = false) => {
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

			if (!autoSafe) {
				setDropdownOpen(false);
			}
		},
		[setLocalNodes, getNodes, setLocalEdges, getEdges],
	);

	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (
				event.key === 's' &&
				(isAppleProduct ? event.metaKey : event.ctrlKey)
			) {
				event.preventDefault();
				saveNodesAndEdges();
			}
		}
		document.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [saveNodesAndEdges, isAppleProduct]);

	useEffect(() => {
		const interval = setInterval(() => {
			if (autoSave) {
				saveNodesAndEdges(true);
			}
		}, 1000 * 30);

		return () => clearInterval(interval);
	}, [autoSave, saveNodesAndEdges]);

	return (
		<DropdownMenu open={dropDownOpen}>
			<DropdownMenuTrigger asChild disabled={dropDownOpen}>
				<Button
					variant="ghost"
					title="Options"
					onClick={() => setDropdownOpen(!dropDownOpen)}
				>
					<Icons.Menu />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="mr-4"
				onEscapeKeyDown={closeDropdown}
				onInteractOutside={closeDropdown}
			>
				<DropdownMenuItem onClick={() => saveNodesAndEdges()}>
					Save
					<DropdownMenuShortcut>
						{isAppleProduct ? '⌘' : 'ctrl'}+s
					</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuCheckboxItem
					checked={autoSave}
					onClick={() => setAutoSave(!autoSave)}
				>
					Auto save
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<MqttSettingsForm
					onClose={closeDropdown}
					trigger={<DropdownMenuItem>MQTT settings</DropdownMenuItem>}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
		// <>
		//   <Button onClick={() => setDrawerOpen(true)} variant="ghost" title="Settings" disabled={drawerOpen}>
		//     <Icons.Menu />
		//   </Button>
		//   <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} nested>
		//     <DrawerContent>
		//       <DrawerHeader className="max-w-xl w-full m-auto mt-6">
		//         <DrawerTitle className="flex items-center justify-between">
		//           Settings
		//           <span className="text-xs font-light text-neutral-500">subtext</span>
		//         </DrawerTitle>
		//         <DrawerDescription>Updates will be automatically applied</DrawerDescription>
		//       </DrawerHeader>
		//       <section className="max-w-xl w-full m-auto flex flex-col space-y-4 mb-8 p-4">
		//         contentcontent
		//       </section>
		//       <DrawerFooter className="max-w-xl w-full m-auto">
		//         {/* Footer */}
		//       </DrawerFooter>
		//     </DrawerContent>
		//   </Drawer>
		// </>
	);
}
