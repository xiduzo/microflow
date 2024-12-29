---
title: Motion
---

{% tags %}
{% tag title="Digital" /%}
{% tag title="Input" /%}
{% /tags %}

A motion node allows to detect motion in the environment. On the hardware component you can usually adjust the sensitivity of the sensor.

{% iframe src="https://www.tinkercad.com/embed/79HFtaYr4U0" /%}

## Hardware configuration
On the breakout board, you can control the _sensitivity and delay time_ of the sensor as well as the _mode of operation_.

### Sensitivity and delay time time
But turning the knobs on the breakout board, you can adjust the sensitivity and delay time of the sensor. Turning the knobs clock-wise will increase the sensitivity and delay time respectively.

![Sensitivity and delay time](/images/motion-knobs.svg)

### Mode of operation
The sensor can be set to two modes of operation: **Single trigger mode** (`L`) and **Repeat trigger mode** (`H` or `B`).

**Single trigger mode** activates output once upon detecting motion and ignores further motion until the delay time has elapsed while **Repeat trigger mode** activates output upon detecting motion and keeps it active as long as motion continues, resetting the delay timer with each new motion detection.

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
