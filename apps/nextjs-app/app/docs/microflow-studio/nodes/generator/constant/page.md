---
title: Constant
---

{% tags %}
{% tag title="Generator" /%}
{% /tags %}

A Constant node provides a fixed number that never changes. Think of it as a number you set once and it stays the same.

**Examples:**
- Set a constant value of 100 to use as a threshold for comparisons
- Use a constant value of 5 to multiply sensor readings by
- Provide a fixed brightness level (like 128) for an LED

This is useful when you need a specific number in your flow that doesn't come from a sensor or change over time. You can combine it with the [`Calculate`](/docs/microflow-studio/nodes/transformation/calculate) node to do math - for example, multiply a sensor reading by your constant value.
