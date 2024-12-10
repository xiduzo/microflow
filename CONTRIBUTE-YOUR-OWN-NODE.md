## How to add your own node

1. Create a component first in `packages/components/src/YourNode.ts`,
your type must extend the BaseComponent class.

```
export class MyComponent extends BaseComponent<MyComponentValueType> {}
```

2. Include your newly created component in the `index.ts` file in `packages/components`

This will make your new components available in the `@microflow/components` package, so that they can be used later in the electron app.

3. Create a reactflow component for your node type in `apps/electron-app/src/common/render/componenets/react-flow/nodes/YourNode.tsx`
4. Implement here your JSX, your config panel and your panel setting defaults.
5. Add a reference in `apps/electron-app/src/common/nodes.ts`
6. Add some JSX in `apps/electron-app/src/render/NewNodeProvider.tsx` so that it appears in the search menu.
