---
title: Delay
---

{% tags %}
{% tag title="Control" /%}
{% tag title="Event" /%}
{% /tags %}

The Delay node makes your flow wait for a certain amount of time before continuing. Instead of acting immediately when something happens, you can pause and then proceed.

**Examples:**
- Wait 2 seconds after a button is pressed before turning on an LED
- Delay turning off a light for 5 seconds after motion is detected
- Create a pause between actions in a sequence

**Debouncing:** This is a special feature that resets the timer every time the input changes. This is useful when you want to wait for things to settle down. For example, if a sensor is giving you lots of quick readings, you can set it to wait 1 second after the last reading before doing something. This prevents acting on every single reading and instead waits until things have been stable for a moment.
