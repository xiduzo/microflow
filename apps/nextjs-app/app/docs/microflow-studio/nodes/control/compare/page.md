---
title: Compare
---

{% tags %}
{% tag title="Control" /%}
{% /tags %}

The Compare node lets you check if something meets certain conditions and make decisions based on that check.

For example, you can check if a sensor reading is greater than 100, equal to 50, or less than 10. Based on whether the condition is true or false, the node sends a signal down different paths in your flow.

**Simple example:** If a temperature sensor reads above 80 degrees, turn on a fan. Otherwise, keep the fan off.

When you want to detect changes or patterns (like "when the value increases by 10") rather than checking exact values, you can use the [`Trigger`](/docs/microflow-studio/nodes/event/trigger) node instead.
