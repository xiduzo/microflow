---
title: Servo
---

{% tags %}
{% tag title="Analog" /%}
{% tag title="Output" /%}
{% /tags %}

A servo is a small motor which can be rotated. Servos are commonly used in robotics to control the movement of robot arms, legs, and other parts.

{% callout type="note" title="Servo type" %}
There are two types of servos out there: `positional` and `continuous`.

The `positional` servo can only be set to a specific angle, while the `continuous` servo can only be set to a specific speed and direction.

When the label on the servo mentions `360`, it is a `continuous` servo. Otherwise it is most likely a `positional` servo.
{% /callout %}

{% iframe src="https://www.tinkercad.com/embed/5Vbfx7Fy56H" /%}

{% callout type="warning" title="Power consumption" %}
Servos can draw a lot of power, especially when they are moving. Make sure to use a power supply that can provide enough current to power your servo.

Powering the servo directly from the microcontroller can cause the microcontroller to reset or behave erratically. It is advised to power the servo from a separate power supply.
{% /callout %}

## Resources

- [Johnny-Five](https://johnny-five.io/api/servo/)
