---
title: Map
---

{% tags %}
{% tag title="Transformation" /%}
{% /tags %}

The Map node converts a number from one range to another range. This is useful when you need to translate values between different scales.

**Simple example:** Imagine you have a sensor that gives you values between 0 and 100, but you need values between 0 and 10 for an LED brightness. The Map node converts 50 (which is in the middle of 0-100) to 5 (which is in the middle of 0-10).

![Simple mapping of values from 0-100 to 0-10](/images/range-map-simple.svg)

**Real-world use:** A light sensor might read values from 0 to 1023, but you want to control an LED brightness from 0 to 255. The Map node automatically converts any sensor reading to the correct brightness value.

You can map any input range to any output range - they don't have to match. For example, you could convert values from 30-80 to 28-115, or any other ranges you need.

![Complex mapping of values from 30-80 to 28-115](/images/range-map-complex.svg)

The output range can be completely different from the input range - it doesn't have to overlap at all.


## Resources

- [Map explained](https://www.youtube.com/watch?v=nicMAoW6u1g)
