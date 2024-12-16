## Some thoughts

- [ ] it feels a bit unhandy that the inputs are on the left side of the node and the outputs are a the bottom. This kind of forces the program to grow in a starcase shape downwards towards the right, which forces scrolling in two directions instead of just up-down or left-right. In biggish sketches it would be more usable to have a dataflow that travel in one axis only.
- [x] for some reason to delete a node I must select it and delete it twice
- [x] difference between the `save` and the `save & close` button in the settings pannel not very clear, what is saved? you mean apply new settings to node? or save state in file? bit unclear? could the settings be applied just 'on change' in the dialog entry?
- [x] when I was messing around with the codebase to add a new node type I saw the app fail silently... I thought that was a javascript feature that was not possible with typescript.

## Nodes
- [x] If..Else is strangely named because technically you cannot do an Else with it, only an If. :) Maybe this node could be called **Compare**?
- [ ] Would be awesome if Debug could "autorange"  :)
    - [x] and maybe instead of **Debug** it could be called **Plot** or **Graph**?

Nodes that would be nice to have:
- [x] **Trigger** node, that outputs a 1 when a specific threshold is reached, with configurable options to *trigger on* `increasing values` or `decreasing values`
- [x] **Smooth** node that makes an analog input less noisy
- [ ] **Math** node that can take two inputs and perform an operation on them `add`, `substract`, `multiply`, `divide`, `modulo`
- [ ] **Constant** node that takes a value and never changes (for example if you want to divide all incoming signals by 2, you create a node with a constant = 2 and a math node)
- [ ] **Delay** node, gives output only after `xyz` milliseconds after receiving input

Ninja-level nodes:
- [ ] **MovingAverage** node, calculates the average of an analog signal based on a number of samples
- [ ] **Spike** node, detects a certain percentage of change from the incoming analog signal (for example values dropped 10%, or values increased 15%)

## Bugs?
- [x] refresh rate of debug is waaaaaaay slow
- [x] interval rate of oscillator is set to 50fps but only 41fps are produced, is that the maximum refresh rate of johnny-five or where does this limitation come from?

## Developer happines stuff
Mostly API-level stuff, pet-peeves, OCD stuff, things I wish (as a developer) were easier to do.

- [x] adding a new node requires quite some boilerplate, I see myself copying and pasting quite a lot of stuff from other components.
- [x] somewhat incoherent API, for example when I needed an attribute value I expected a function like `const value = useNodeAttribute<OscillatorData>(id, 'period', 0);`, but it turns out it was a lot easier and all I needed was `const { id, data } = useNode();` and then I could use the `data` object to fetch stuff from it like so `const waveform = data['waveform'];`. I prefer the way it is, but the inconsistency had me going around in circles for a while. It is slightly maddedning that intuition doesn't work in this codebase. I blame React for this, and the fact that some things have a more reactish API, while others are closer to the cleaner object model under it. I don't think there's an easy way to fix this that doesn't involve writing a ton of stupid wrappers. You probably do not feel any of this because React is second-nature to you by now. But for a React-virgin this way of doing things is weird.
- [x] more about coherence, Node properties are called Data in the code, Properties in some places, Settings in the `.tsx` file. Not a biggie but would be nice to settle on one word and name it the same across the entire codebase. I would propose *attributes*, because `settings` applies to too many things in app development and `properties` is more related to object-orientedness and can also get confusing.
- [ ] same thing about the words `Component` and `Node`, one has `BaseComponent.ts` in `@microflow/components` and `Node.tsx` in the presentation layer. You get used to it pretty quickly, and it makes some sense I guess, but makes the codebase a bit disorienting for a noob.
- [ ] As an outsider non-React developer I would very much love if the model component `.ts` file and the presentation Node `.tsx` file where alongside each other in the project structure. I don't know how many times I had to fish out a file in the five-subfolder structure of the electron-app to change something that felt like it belonged in the model. Made me cringe in frustration a few times.
- [x] `BaseComponent.ts` assumes that `change` happens when the value changes, but this is not always true. When writing the `Trigger` node I found situations were I wanted to send an output signal that didn't have a specific value. In the end I settled for sending out a 1.0 for `trigger happened` (or `bang` as it's called in other flow-based languages) and a `0.0` when `trigger didn't happen`. My first implementation was like this:

```
	/**
	 * @TODO apparently this doesn't work
	 *
	 * bang the output 'change' gate
	 */
	public bang() {
		let value: number = 1.0;
		this.eventEmitter.emit('change', JSON.stringify(value));
	}

	/**
	 * "unbang"
	 */
	public quiet() {
		let value: number = 0.0;
		this.eventEmitter.emit('change', JSON.stringify(value));
	}
```

You can still see the vestiges of this approach in `BaseComponent.ts`. This never worked, and after staring at it for hours I honestly do not know why. Instead I had to do this in the child component:

```
		if (retval) {
			this.value = 1.0; // not ideal, I don't really want to send a specific value here but rather a gate bang
			setTimeout(() => {
				this.value = 0.0;
			}, this.options.duration);
```

In my opinion it would be nice if there was a very straight-foward way in `BaseComponent.ts` to just send a pulse/bang to the next node, a way that is independant of value just so that the developer doesn't have to thing about it. Something happened in this node and I just want to notify the next node down the chain.
