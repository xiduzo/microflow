---
title: Edges
---

Edges allow you to connect [nodes](/docs/microflow-studio/nodes) together to create a flow of data.

Edges are created by dragging a connection from one node's handle to another node's handle.

## Examples

Flows can be simple or complex, depending on the number of nodes and the connections between them.

### Simple flow

In this example, we have a simple flow with two nodes connected by an edge. When a button is pressed, the LED turns on.

```mermaid
flowchart LR
    A[Button]-- Down handle -->B[LED]
```

// TODO: add download file for simple flow

### Complex flow

In this example, we have a more complex flow with multiple nodes connected by edges.

When a button is pressed, the counter increments. The counter value is then mapped to a range of values. If the counter value is greater than _N_, the LED turns on. Otherwise, the piezo buzzer turns on.

```mermaid
flowchart LR
    A[Button] -- Up handle --> B[Counter]
    B -- Change handle --> C[Map]
    C -- Change handle --> D[if..else]
    D -->|True handle| E[Piezo one]
    D -->|False handle| F[Piezo two]
```

// TODO: add download file for complex flow
