---
title: Smooth
---

{% tags %}
{% tag title="Transformation" /%}
{% /tags %}

Some sensors can give you jumpy or noisy readings that change rapidly and unpredictably. The Smooth node helps stabilize these readings by averaging them out.

**How it works:** The Smooth node takes the last several readings and calculates their average. Instead of using each individual reading (which might jump around), it uses the average, which gives you a more stable, smoother value.

**Example:** A light sensor might read 100, then 105, then 98, then 102 - jumping around even when the light hasn't really changed. The Smooth node averages these values to give you a steadier reading around 101, making it easier to work with.

This is especially useful for analog sensors that can be sensitive to small changes or electrical noise.
