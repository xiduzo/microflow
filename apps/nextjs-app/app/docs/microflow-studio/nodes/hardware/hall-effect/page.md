---
title: Hall effect
---

{% tags %}
{% tag title="Analog" /%}
{% tag title="Input" /%}
{% /tags %}

A hall effect sensor is a sensor that detects the presence of a magnetic field. It will detect both the north and south pole of a magnet. The sensor will output a voltage that is proportional to the strength of the magnetic field. `Microflow` **only** supports analog hall effect sensors.

North pole {% .text-red-500 .font-bold %}

When recognizing a north pole, the output voltage will _decrease_.

South pole {% .text-blue-500 .font-bold %}

When recognizing a south pole, the output voltage will _increase_.



## Wiring
Not every hall effect sensor is the same, but most of them have three pins: 5V, GND, and SIG.

Depending on the sensor the wiring may differ.

### 503

![hall 503](/images/hall-503.svg) {%  .w-40  %}

## Resources

- [Johnny-Five](https://johnny-five.io/api/sensor/)
