---
title: Nodes
---

Nodes are the building blocks of any flow.

They are the basic units of computation and can be connected to each other to form a flow. Nodes can be of different types, such as input, output, or processing nodes. Each node has a set of properties that define its behavior and configuration.

By connecting nodes together, using [edges](/docs/microflow-studio/edges), you can create complex interactions that perform a wide range of tasks.

For example, you can create a flow that reads data from a sensor, processes the data, and then sends the result to an output device.

## Atonomy of a Node

Nodes are being connected with [edges](/docs/microflow-studio/edges) to form a flow. Each node has a set of handles that can be connected to other nodes.

![Visual representation of the atonomy of a node](/images/node-atonomy.svg)

Input handles {% .text-blue-500 .font-bold %}

A node can have 0 or more input handles. Other nodes can connect to these handles to provide input to the node. This input can trigger an action or change the node's value.

Output handles {% .text-green-500 .font-bold %}

A node can have 0 or more output handles. These handles are used to connect the node to other nodes. Each node will have their own specific outputs which can be used to trigger other nodes.

Node value {% .text-yellow-500 .font-bold %}

The value of a node can be represented in different ways, depending on the node type. This could either be a number, a string, a toggle switch, a color an icon, etc. This value will give some insights in the current state of the node.

Settings {% .text-gay-400 .font-bold %}

Changing the behaviour of the node can be done by changing the settings of the node. This can be done by clicking the settings icon in the top right corner of the node.
