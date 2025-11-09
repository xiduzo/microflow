---
title: LED
---

{% tags %}
{% tag title="Output" /%}
{% tag title="Analog" /%}
{% tag title="Digital" /%}
{% /tags %}

A Light Emitting Diode (LED) is a simple output device that emits light when an electric current passes through it.
LEDs are commonly used in electronics projects to indicate the status of a circuit or to provide visual feedback.

{% iframe src="https://www.tinkercad.com/embed/4yVN8T26DNI" /%}

## LED - RGB

Compared to a regular LED, a RGB LED allows you to individually control the intensity of each of the three primary colors (Red, Green, and Blue) that make up the LED.

{% iframe src="https://www.tinkercad.com/embed/cCDJogFuJU1" /%}

## LED - matrix
For now, only basic `8x8` LED matrixes are supported.

You are able to customise the display of the matrix by an embedded editor in Microflow. This editor allows you to draw a sequence of frames that will be displayed on the matrix.

The frame that will be displayed can be configured by passing in a the numeric value in the `show` handle of the node.

{% callout type="note" title="Counting like a coder" %}
The frames start counting from `0`, meaning the first frame is `0`, the second frame is `1`, and so on.
{% /callout %}

[Download LED matrix example flow](/flow-examples/led_matrix.microflow)

## Resources

- [Johnny-Five LED](https://johnny-five.io/api/led/)
- [Johnny-Five RGB LED](https://johnny-five.io/api/led.rgb/)
- [Johnny-Five LED Matrix](https://johnny-five.io/api/led.matrix/)
- [Arduino](https://docs.arduino.cc/built-in-examples/basics/Blink/)
