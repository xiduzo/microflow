---
title: How to add your own node
---

Adding your own node requires a bit of boilerplate and manual work at the moment.

## Step 1: creating your own component type

Let's say you want to create your own node type called `MyNode`. First you need to create a file with it's own class in `packages/components/src/YourNode.ts` your type must extend the BaseComponent class. Here's an example declaration:

```ts
export type MyNodeValueType = number;

export class MyNode extends BaseComponent<MyNodeValueType> {}
```

Let's now say that your node type will have a configuration panel where you can change some attributes, for now let's say the attributes are a drop-down that let's you choose between `happy` and `sad`, and a numeric value we call `joy`. To be able to contain the values of these attributes you will need a data type associated to your node.

```ts
export type EmotionType = 'happy' | 'sad';

export type MyNodeData = {
	emotion: EmotionType;
	joy: number;
};
```

Add a constructor to your type that takes the attributes and passes them to the superclass. Like this:

```ts
constructor(private readonly data: BaseComponentData & MyNodeData) {
	super(data, 0);
}
```

## Step 2: expose your new type in the components packages

- Include your newly created component in the `index.ts` file in `packages/components`. This will make your new components available in the `@microflow/runtime` package, so that they can be used later in the electron app.

## Step 3: create a react wrapper in the electron app

- Create a reactflow wrapper for your node type in `apps/electron-app/src/common/render/componenets/react-flow/nodes/YourNode.tsx`
- Implement here your JSX

```tsx
export function MyNode(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='input' />
			<Handle type='source' position={Position.Right} id='output' />
		</NodeContainer>
	);
}
```

- Show how much `joy` you are in right now

```tsx
function Value() {
    const value = useNodeValue<MyNodeValueType>(0) // Acces the nodes' internal value
    const data = useNodeData<MyNodeData>() // Access the node data

    return {
        <div>{value} / {data.joy}</div>
    }
}
```

- Give the user freedom to configure the node

```tsx
function Settings() {
	const data = useNodeData<MyNodeData>();
	const { render } = useNodeControls<MyNodeData>({
		emotion: { value: data.emotion, label: 'validate', options: ['happy', 'sad'] },
		joy: { value: data.joy, min: 1, max: 100, step: 0.5 },
	});

	return <>{render()}</>;
}
```

- And your panel data defaults.

```ts
type Props = BaseNode<MyNodeData>;
MyNode.defaultProps = {
	data: {
		group: 'flow',
		tags: ['information'],
		label: 'MyNode',
		emotion: 'happy',
		joy: 95,
	} satisfies Props['data'],
};
```

- Add a reference in `apps/electron-app/src/common/nodes.ts` to expose your node to the app.

```ts
import { MyNode } from '../render/components/react-flow/nodes/MyNode';

export const NODE_TYPES = {
	//...
	MyNode: MyNode,
	//...
};
```
