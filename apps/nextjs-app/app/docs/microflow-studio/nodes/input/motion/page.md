---
title: Motion
---

{% tags %}
{% tag title="Input" /%}
{% tag title="Digital" /%}
{% /tags %}

A Motion node detects when something moves in its field of view. It's commonly used for security systems, automatic lights, or any project that needs to know when someone or something is nearby.

**How it works:** The sensor detects infrared radiation (heat) from moving objects. On the physical sensor component, you can usually adjust how sensitive it is and how long it stays active after detecting motion.

{% iframe src="https://www.tinkercad.com/embed/79HFtaYr4U0" /%}

## Hardware configuration
On the breakout board, you can control the _sensitivity and delay time_ of the sensor as well as the _mode of operation_.

### Sensitivity and delay time

On the physical sensor board, there are usually two small knobs you can adjust with a screwdriver:

- **Sensitivity knob:** Controls how easily the sensor detects motion. Turn clockwise to make it more sensitive (detects smaller movements or from farther away). Turn counter-clockwise to make it less sensitive.
- **Delay time knob:** Controls how long the sensor stays "active" after detecting motion. Turn clockwise for a longer delay (sensor stays on longer), turn counter-clockwise for a shorter delay.

![Sensitivity and delay time](/images/motion-knobs.svg)

### Mode of operation
The sensor can be set to two modes of operation: **Single trigger mode** (`L`) and **Repeat trigger mode** (`H` or `B`).

**Single trigger mode:** Detects motion once, activates, then ignores all motion until the delay time is over. Even if you keep moving, it won't detect again until the timer runs out.

**Repeat trigger mode:** Stays active as long as there's motion. Every time it detects new motion, it resets the timer. Only turns off after motion has completely stopped for the full delay period.

![Operation mode](/images/motion-mode.svg)

#### Repeat trigger mode

- **Behavior:** In repeat trigger mode, the PIR sensor will activate its output when it detects motion and keep the output active as long as motion continues to be detected. The delay timer resets each time motion is detected. The output will only turn off after the delay time has elapsed without any further motion detection.
- **Use Case:** This mode is useful in scenarios where you want the sensor to keep the output active as long as there is motion. For example, keeping a light on as long as there is movement in the area and turning it off only after the area has been still for the entire delay period.

#### Single trigger mode

- **Behavior:** In single trigger mode, the PIR sensor will activate its output (e.g., turn on a light or send a signal) when it detects motion. The output will remain active for a predetermined period (the delay time) and then turn off, regardless of whether motion continues to be detected.
- **Use Case:** This mode is useful in scenarios where you want the sensor to trigger an action once and then ignore further motion until the delay time has elapsed. For example, turning on a light for a set period when motion is first detected, and then turning it off after the delay time, even if there is continued motion.



{% iframe src="https://www.youtube.com/embed/2dZ4cfluTTU?si=E5RajDoHX95BV0EQ" /%}

## Resources

- [Johnny-Five](https://johnny-five.io/examples/ir-motion/)
