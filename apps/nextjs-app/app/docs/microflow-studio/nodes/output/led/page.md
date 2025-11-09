---
title: LED
---

{% tags %}
{% tag title="Output" /%}
{% tag title="Analog" /%}
{% tag title="Digital" /%}
{% /tags %}

An LED (Light Emitting Diode) is a small light that turns on when electricity flows through it. LEDs are commonly used in electronics projects to show status, provide feedback, or create visual effects.

**How it works:** Connect an LED to your microcontroller, and the LED node can turn it on, turn it off, or control its brightness. LEDs are perfect for indicating when something is happening in your flow - like showing when a button is pressed, when a sensor detects something, or just as a status indicator.

{% iframe src="https://www.tinkercad.com/embed/4yVN8T26DNI" /%}

## LED - RGB

An RGB LED is like three LEDs in one - it has red, green, and blue lights all in the same component. By controlling how bright each color is, you can create any color you want!

**How it works:** Instead of just on/off or brightness, you control three values (red, green, blue) from 0 to 255. Mixing these values creates different colors - for example, full red + full green = yellow, all three at full = white, all at zero = off.

{% iframe src="https://www.tinkercad.com/embed/cCDJogFuJU1" /%}

## LED - matrix

An LED matrix is a grid of LEDs (like an 8x8 grid = 64 LEDs) that can display patterns, shapes, or simple animations. Currently, Microflow supports basic 8x8 LED matrices.

**How it works:**

- You can draw patterns using an editor built into Microflow
- You can create multiple "frames" (like animation frames) that show different patterns
- To display a specific frame, send a number to the `show` input handle

{% callout type="note" title="Counting like a coder" %}
The frames are numbered starting from 0, not 1. So the first frame is frame 0, the second frame is frame 1, the third is frame 2, and so on. This is common in programming - just remember to start counting from zero!
{% /callout %}

[Download LED matrix example flow](/flow-examples/led_matrix.microflow)

## Resources

- [Johnny-Five LED](https://johnny-five.io/api/led/)
- [Johnny-Five RGB LED](https://johnny-five.io/api/led.rgb/)
- [Johnny-Five LED Matrix](https://johnny-five.io/api/led.matrix/)
- [Arduino](https://docs.arduino.cc/built-in-examples/basics/Blink/)
