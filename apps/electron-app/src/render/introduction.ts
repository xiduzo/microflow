import { Edge, Node } from "@xyflow/react";

export const INTRODUCTION_NODES = [
    {
        "data": {
            "label": "Note",
            "value": "Welcome to Microflow studio!\n\nDouble click me 👀",
            "settingsOpen": false,
            "animated": false
        },
        "id": "v7gl9d",
        "type": "Note",
        "position": {
            "x": 397,
            "y": 236
        },
        "selected": false,
        "measured": {
            "width": 224,
            "height": 176
        },
        "dragging": false
    },
    {
        "data": {
            "label": "Interval",
            "interval": 500,
            "value": 0,
            "id": "l54z34",
            "animated": false,
            "settingsOpen": false
        },
        "id": "l54z34",
        "type": "Interval",
        "position": {
            "x": 120,
            "y": 240
        },
        "selected": false,
        "measured": {
            "width": 224,
            "height": 176
        }
    },
    {
        "data": {
            "label": "LED",
            "pin": 13,
            "value": 0,
            "id": "z9amaw",
            "animated": false,
            "settingsOpen": false
        },
        "id": "z9amaw",
        "type": "Led",
        "position": {
            "x": 397,
            "y": 461
        },
        "selected": false,
        "measured": {
            "width": 224,
            "height": 176
        },
        "dragging": false
    }
] satisfies Node[];

export const INTRODUCTION_EDGES = [
    {
        "source": "l54z34",
        "sourceHandle": "change",
        "target": "z9amaw",
        "targetHandle": "toggle",
        "id": "xy-edge__l54z34change-z9amawtoggle",
        "selected": false,
        "animated": false
    }
] satisfies Edge[];
