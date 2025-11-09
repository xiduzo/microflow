---
title: Sensor
---

{% tags %}
{% tag title="Input" /%}
{% tag title="Analog" /%}
{% /tags %}

If you have a sensor that isn't specifically mentioned in the documentation, you can still use it with Microflow! You just need to know whether it's a digital or analog sensor.

**Digital vs Analog:**
- **Digital Sensor:** Gives you simple on/off or yes/no readings (like a motion detector that says "motion detected" or "no motion")
- **Analog Sensor:** Gives you a range of values (like a light sensor that reads from 0 to 1023, where 0 is completely dark and 1023 is very bright)

## Digital Sensor

A digital sensor detects whether something is present or not, on or off, above or below a threshold. It gives you simple yes/no information.

## Analog Sensor

An analog sensor measures a continuous range of values. These sensors can be used to measure a variety of things, such as:

- [Rotary Potentiometer](/docs/microflow-studio/nodes/input/potentiometer)
- [Linear Potentiometer](/docs/microflow-studio/nodes/input/potentiometer#2-channel-sliding-potentiometer)
- Flex Sensitive Resistor
- Pressure Sensitive Resistor
- [Force Sensitive Resistor](/docs/microflow-studio/nodes/input/force)
- [Hall Sensor](/docs/microflow-studio/nodes/input/hall-effect)
- [Tilt Sensor](/docs/microflow-studio/nodes/input/tilt)
- [Photoresistor/Light Dependent Resistor (LDR)](/docs/microflow-studio/nodes/input/ldr)

...And many more.

## Resources

- [Johnny-Five](https://johnny-five.io/api/sensor/)
