---
title: Switch
---

{% tags %}
{% tag title="Input" /%}
{% tag title="Digital" /%}
{% /tags %}

A switch is similar to a [`Button`](/docs/microflow-studio/nodes/input/button), but with an important difference: a switch stays in its position until you change it, while a button only works while you're pressing it.

**Button:** Press and hold = on, release = off (like a doorbell)
**Switch:** Flip it on = stays on, flip it off = stays off (like a light switch on your wall)

Switches are useful when you want something to stay on or off until you manually change it, rather than requiring constant pressure like a button.

{% iframe src="https://www.tinkercad.com/embed/dxxCQPOmd5e" /%}

## Types of switches

Switches come in many shapes and sizes. Below are a few examples and how to wire them up.

{% callout type="note" title="Wiring" %}
The wiring examples are for illustrative purposes, it might not work with your particular switch.
{% /callout %}

**Understanding switch states:**

Different switches work in different ways. Here's how to understand what your microcontroller sees:

| Switch Type | Switch Position | What the Microcontroller Reads |
|-------------|-----------------|-------------------------------|
| Normally Open (NO) | On (pressed/flipped) | HIGH (1) - meaning "active" |
| Normally Open (NO) | Off (not pressed) | LOW (0) - meaning "inactive" |
| Normally Closed (NC) | On (pressed/flipped) | LOW (0) - meaning "inactive" (opposite!) |
| Normally Closed (NC) | Off (not pressed) | HIGH (1) - meaning "active" (opposite!) |

**What does this mean?** Normally Closed switches work backwards - when they're "on" they send LOW, and when they're "off" they send HIGH. This is just how that type of switch is wired internally.

### 2 pin on-off switch

A 2 pin switch requires a _resistor_ to work properly.

![2 pin on-off switch](/images/2-pin-on-off-switch.svg) {%  .w-60  %}

### 3 pin on-off switch

A 3 pin switch is similar to a 2 pin switch, it does not require a _resistor_ but it has an additional pin that is connected to the input pin.

The input pin is usually connected to the middle pin, while the other two pins are connected to the ground and power.

![3 pin switch](/images/3-pin-on-off-switch.svg) {%  .w-52  %}

## Resources

[Johnny-Five](https://johnny-five.io/api/switch/)
