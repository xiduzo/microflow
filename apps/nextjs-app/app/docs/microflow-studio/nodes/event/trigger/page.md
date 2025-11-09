---
title: Trigger
---

{% tags %}
{% tag title="Event" /%}
{% tag title="Control" /%}
{% /tags %}

The Trigger node detects when values change in a specific way, rather than checking if they match an exact number (which is what the [Compare](/docs/microflow-studio/nodes/control/compare) node does).

**Examples:**
- Detect when a temperature increases by more than 10 degrees (even if you don't know the exact starting temperature)
- Trigger when a sensor value suddenly drops
- Activate something when a value crosses a threshold going up or down

**Real-world example:** When the temperature of a room increases above a certain threshold, you can trigger an event to turn on the air conditioning. The Trigger node watches for the change, not just checking if it's above a fixed number.
