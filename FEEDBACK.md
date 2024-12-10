## Some thoughts

- it feels a bit unhandy that the inputs are on the left side of the node and the outputs are a the bottom. This kind of forces the program to grow in a starcase shape downwards towards the right, which forces scrolling in two directions instead of just up-down or left-right. In biggish sketches it would be more usable to have a dataflow that travel in one axis only.
- for some reason to delete a node I must select it and delete it twice
- difference between the `save` and the `save & close` button in the settings pannel not very clear, what is saved? you mean apply new settings to node? or save state in file? bit unclear? could the settings be applied just 'on change' in the dialog entry?
- when I was messing around with the codebase to add a new node type I saw the app fail silently... I thought that was a javascript feature that was not possible with typescript.

## Nodes
- If..Else is strangely named because technically you cannot do an Else with it, only an If. :) Maybe this node could be called **Compare**?
- Would be awesome if Debug could "autorange"  :) and maybe instead of **Debug** it could be called **Plot** or **Graph**?

Nodes that would be nice to have:
  - **Trigger** node, that outputs a 1 when a specific threshold is reached, with configurable options to *trigger on* `increasing values` or `decreasing values`
  - **Smooth** node that makes an analog input less noisy
  - **Math** node that can take two inputs and perform an operation on them `add`, `substract`, `multiply`, `divide`, `modulo`
  - **Constant** node that takes a value and never changes (for example if you want to divide all incoming signals by 2, you create a node with a constant = 2 and a math node)
  - **Delay** node, gives output only after `xyz` milliseconds after receiving input
  - **MovingAverage** node, calculates the average of an analog signal based on a number of samples
  - **Spike** node, detects a certain percentage of change from the incoming analog signal (for example values dropped 10%, or values increased 15%)
