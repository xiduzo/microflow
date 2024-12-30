---
title: Switch
---

{% tags %}
{% tag title="Digital" /%}
{% tag title="Input" /%}
{% /tags %}

Similar to a [`Button`](/docs/microflow-studio/nodes/hardware/button), a switch is a simple input device that can be either open or closed.

In comparison, a switch will hold its state until it is changed, while a button will only be active while it is being pressed.

{% iframe src="https://www.tinkercad.com/embed/dxxCQPOmd5e" /%}

## Types of switches

Switches come in many shapes and sizes. Below are a few examples and how to wire them up.

{% callout type="note" title="Wiring" %}
The wiring examples are for illustrative purposes, it might not work with your particular switch.
{% /callout %}

**Is my button active table**
| Switch Type | Switch State | Input Pin State |
|-------------|--------------|-----------------|
| Normally Open (NO) | On | HIGH (1) |
| Normally Open (NO) | Off | LOW (0) |
| Normally Closed (NC) | On | LOW (0) |
| Normally Closed (NC) | Off | HIGH (1) |

### 2 pin on-off switch

A 2 pin switch requires a _resistor_ to work properly.

![2 pin on-off switch](/images/2-pin-on-off-switch.svg) {%  .w-60  %}

### 3 pin on-off switch

A 3 pin switch is similar to a 2 pin switch, it does not require a _resistor_ but it has an additional pin that is connected to the input pin.

The input pin is usually connected to the middle pin, while the other two pins are connected to the ground and power.

![3 pin switch](/images/3-pin-on-off-switch.svg) {%  .w-52  %}

## Resources

[Johnny-Five](https://johnny-five.io/api/switch/)
