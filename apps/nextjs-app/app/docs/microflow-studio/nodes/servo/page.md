---
title: Servo
---

{% tags %}
{% tag title="Analog" /%}
{% tag title="Output" /%}
{% /tags %}

A servo is a small motor which can be rotated to a specific angle. Servos are commonly used in robotics to control the movement of robot arms, legs, and other parts.

{% callout type="warning" title="Power consumption" %}
Servos can draw a lot of power, especially when they are moving. Make sure to use a power supply that can provide enough current to power your servo.

Powering the servo directly from the microcontroller can cause the microcontroller to reset or behave erratically. Always power the servo from a separate power supply.
{% /callout %}

## Resources

- [Johnny-Five](https://johnny-five.io/api/servo/)
