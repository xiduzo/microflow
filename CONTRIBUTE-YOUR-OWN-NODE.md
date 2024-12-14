## How to add your own node

1. Create a component first in `packages/components/src/YourNode.ts`,
your type must extend the BaseComponent class.

```
export class MyComponent extends BaseComponent<MyComponentValueType> {}
```

2. Include your newly created component in the `index.ts` file in `packages/components`. This will make your new components available in the `@microflow/components` package, so that they can be used later in the electron app.
3. run `yarn build` in the `microflow/packages/components` directory, you need to do this before you run yarn at the `app` level directories
4. Create a reactflow component for your node type in `apps/electron-app/src/common/render/componenets/react-flow/nodes/YourNode.tsx`
5. Implement here your JSX, your config panel and your panel setting defaults.
6. Add a reference in `apps/electron-app/src/common/nodes.ts`
7. Add some JSX in `apps/electron-app/src/render/NewNodeProvider.tsx` so that it appears in the search menu.
