# Microflow UI/UX Design Handover

A comprehensive guide for junior designers joining the Microflow project.

---

## 1. Product Overview

Microflow is a visual flow-based programming tool for hardware prototyping and IoT development. Users create interactive flows by connecting nodes that represent hardware components (buttons, LEDs, sensors, servos), data transformations, and control logic.

**Target Users:** Makers, educators, and developers prototyping hardware projects without writing low-level code.

**Platforms:** Web browser + Native desktop app (via Tauri)

---

## 2. Design System

### Color Palette
- **Theme Support:** Light, Dark, and System-auto modes
- **Primary Colors:** Uses Tailwind CSS color system
- **Collaboration Colors:** 16 predefined colors for user avatars (see `COLLAB_COLORS`)
- **Flow Colors:** 17 pastel colors for flow identification (red-300 through rose-300)

### Typography & Spacing
- Built on **shadcn/ui** component library
- Uses Tailwind CSS v4 utility classes
- Consistent spacing scale (4px base unit)

### Iconography
- **Lucide Icons** throughout the app
- Custom icon mapping for node types (e.g., `LightbulbIcon` for LED, `PointerIcon` for Button)
- Collaboration avatars use animal icons (Bird, Cat, Dog, Fish, etc.)

---

## 3. Application Structure

### 3.1 Global Layout
```
┌─────────────────────────────────────────────────────────┐
│  ┌──────────┐  ┌─────────────────────────────────────┐  │
│  │          │  │                                     │  │
│  │ Sidebar  │  │           Main Content              │  │
│  │          │  │                                     │  │
│  │          │  │                                     │  │
│  │          │  │                                     │  │
│  └──────────┘  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- **Collapsible Sidebar:** Contains navigation, flow switcher, and user profile
- **Main Content Area:** Full-height, scrollable content zone
- **Toast Notifications:** Top-right position (using Sonner)

### 3.2 Sidebar Navigation

**Sections:**
1. **Flow Switcher** (header) - Dropdown to switch between flows
2. **Microcontroller Status** - Hardware connection indicator
3. **Active Flow Actions:**
   - Edit flow (graph view)
   - Show circuit (beta)
   - Settings (cloud flows only)
   - Export/Import actions
4. **General:**
   - My flows (home)
   - Templates
5. **Configuration** (desktop only):
   - MQTT settings
6. **User Profile** (footer)

---

## 4. Screen-by-Screen Breakdown

### 4.1 Home Page (`/`)

**Purpose:** Dashboard showing user's flows

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│  Your Flows                          [Templates] [+ New]│
│  Manage your local flow and sync to the cloud...        │
├─────────────────────────────────────────────────────────┤
│  Local                                                  │
│  ┌─────────┐                                            │
│  │ Preview │  Local Flow                                │
│  │  (mini  │  "This flow is only available..."          │
│  │  flow)  │                                            │
│  └─────────┘                                            │
├─────────────────────────────────────────────────────────┤
│  Cloud                                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ Flow 1  │ │ Flow 2  │ │ Flow 3  │ │ Flow 4  │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
└─────────────────────────────────────────────────────────┘
```

**Components:**
- **FlowCard:** Shows mini flow preview, name, description, last edited time, role badge
- **Empty State:** When no cloud flows exist (icon + CTA button)
- **Sign-in Nudge:** When user is not authenticated

**Responsive Grid:** 1 → 2 → 3 → 4 columns based on viewport

---

### 4.2 Templates Page (`/templates`)

**Purpose:** Pre-built flow templates for learning

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│  Templates                                              │
│  Start with a pre-built flow to explore...              │
├─────────────────────────────────────────────────────────┤
│  Contains: [All] [Button] [LED] [Sensor] ...            │
│  Difficulty: [All] [Beginner] [Intermediate] [Advanced] │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ Button  │ │ Blink   │ │ Sensor  │ │ Pot     │       │
│  │ to LED  │ │ LED     │ │ Monitor │ │ Servo   │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
└─────────────────────────────────────────────────────────┘
```

**Template Categories:**
- Beginner (green badge)
- Intermediate (yellow badge)
- Advanced (orange badge)
- IoT (blue badge)

**Filter Controls:** Toggle groups for component types and difficulty levels

---

### 4.3 Flow Editor (`/flow/:flowId/graph`)

**Purpose:** Main visual programming canvas

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ [Collab Avatars]                    [Settings Panel ▼]  │
│                                                         │
│                    ┌─────────┐                          │
│                    │  Node   │──────┐                   │
│                    └─────────┘      │                   │
│                                     ▼                   │
│                              ┌─────────┐                │
│                              │  Node   │                │
│                              └─────────┘                │
│                                                         │
│  ┌─────────┐                                            │
│  │ MiniMap │                                            │
│  └─────────┘                                            │
│                                                         │
│           [Undo][Redo] | [+] | [Zoom -][+][Fit]         │
└─────────────────────────────────────────────────────────┘
```

**Key UI Elements:**

1. **Canvas (React Flow)**
   - Infinite pan/zoom canvas
   - Grid background (140px gap)
   - Rounded corners (3xl)
   - Min zoom: 0.05, Max zoom: 1

2. **MiniMap** (bottom-left)
   - Pannable and zoomable
   - Rounded node borders

3. **Dock Panel** (bottom-center)
   - Floating toolbar with:
     - Undo/Redo buttons
     - Add node button (+)
     - Zoom controls (in/out/fit)

4. **Settings Panel** (top-right)
   - Expandable panel for selected node settings
   - Uses Leva controls library

5. **Presence Panel** (top-left)
   - Shows collaborator avatars
   - Stacked with negative margin (-space-x-3)

6. **Collaboration Cursors**
   - Real-time cursor positions of other users
   - Colored mouse pointer + name label

---

### 4.4 Node Design

**Standard Node Structure:**
```
┌─────────────────────────────────────────┐
│ [Icon] Label                    [Error] │
│ Pin: D6                                 │
├─────────────────────────────────────────┤
│                                         │
│           [Visual State]                │
│           (icon/animation)              │
│                                         │
├─────────────────────────────────────────┤
│ ○ active                                │
│ ○ change                         ○ on   │
│ ○ inactive                       ○ off  │
│ ○ hold                                  │
└─────────────────────────────────────────┘
  Handles (left=inputs, right=outputs)
```

**Node States:**
- Default: `bg-muted-foreground/10`
- Selected: `bg-blue-500/20`
- Error: `bg-red-500/20`

**Node Dimensions:** Min width 320px (80 in Tailwind units)

**Handle Design:**
- Small circles on node edges
- Left side = inputs (targets)
- Right side = outputs (sources)
- Offset positioning for multiple handles

---

### 4.5 Add Node Dialog

**Trigger:** Click + button or press `Cmd/Ctrl + K`

**Design:** Command palette style (similar to VS Code/Spotlight)

```
┌─────────────────────────────────────────────────────────┐
│  🔍 Magnetic, Analog, Servo...                          │
├─────────────────────────────────────────────────────────┤
│  input                                                  │
│  ┌────┐                                                 │
│  │ 🔘 │  Button                              hardware   │
│  └────┘  Detect when a physical button is pressed...    │
│          [input] [digital]                              │
│  ┌────┐                                                 │
│  │ 📊 │  Sensor                              hardware   │
│  └────┘  Measure values that change smoothly            │
│          [input] [analog]                               │
├─────────────────────────────────────────────────────────┤
│  output                                                 │
│  ┌────┐                                                 │
│  │ 💡 │  LED                                 hardware   │
│  └────┘  Turn a light on or off...                      │
│          [output] [analog] [digital]                    │
├─────────────────────────────────────────────────────────┤
│  📖 Documentation          [Esc] [↑↓] Navigate [↵] Select│
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Fuzzy search across label, description, tags
- Grouped by first tag (input, output, event, etc.)
- Avatar with icon for each node type
- Badge tags for categorization
- Keyboard navigation hints in footer

**Node Placement:** After selection, node follows cursor until clicked to place

---

### 4.6 Circuit View (`/flow/:flowId/circuit`) [BETA]

**Purpose:** Auto-generated schematic diagram from flow

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ ⟳ Updating...                                           │
│                                                         │
│              [Schematic Diagram]                        │
│                                                         │
│  ┌─────────────┐                                        │
│  │ Legend      │                                        │
│  │ VCC (red)   │                                        │
│  │ GND (gray)  │                                        │
│  │ DIN (blue)  │                                        │
│  │ SIG (yellow)│                                        │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Real-time circuit generation from flow nodes
- Color-coded pin types
- Loading indicator during render
- Legend card (bottom-left)

---

### 4.7 Flow Settings (`/flow/:flowId/settings`)

**Purpose:** Manage cloud flow properties and collaborators

**Sections:**

1. **Flow Details Card**
   - Name input field
   - Color picker (17 pastel options)
   - Save/Reset buttons

2. **Collaborators Card**
   - Table with: Avatar, Name, Email, Role, Actions
   - Owner row (non-editable)
   - Collaborator rows with:
     - Role dropdown (viewer/editor)
     - Remove button
   - Share button in table caption

3. **Danger Zone Card**
   - Delete flow button (destructive)

---

### 4.8 Profile Page (`/profile`)

**Purpose:** User account settings

**Sections:**

1. **Theme Settings**
   - Button group: Dark / System / Light

2. **Collaboration Settings**
   - Color picker (16 colors in circular buttons)
   - Icon picker (13 animal icons)
   - Live preview of avatar

---

### 4.9 Login Page (`/login`)

**Purpose:** Authentication

**Design:** Centered card with form

```
┌─────────────────────────────────────────┐
│  Login to your account                  │
│  Enter your email below to login...     │
├─────────────────────────────────────────┤
│  Email                                  │
│  ┌─────────────────────────────┐ [📧]   │
│  │ m@example.com               │        │
│  └─────────────────────────────┘        │
│                                         │
│  Password                               │
│  ┌─────────────────────────────┐ [🔒]   │
│  │ ••••••••                    │        │
│  └─────────────────────────────┘        │
│                                         │
│  [        Sign In        ]              │
│                                         │
│  Don't have an account? Sign up         │
└─────────────────────────────────────────┘
```

**Toggle:** Switch between Sign In and Sign Up forms

---

### 4.10 MQTT Configuration (`/configuration/mqtt`) [Desktop Only]

**Purpose:** Configure IoT broker connections

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│  MQTT Configuration                        [+ Add Broker]│
│  Configure MQTT brokers for IoT connectivity            │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐│
│  │ ● My Broker                    [⭐][✏️][🗑️]         ││
│  │   wss://broker.example.com:8883/mqtt                ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  Test Client                                            │
│  ┌─────────────────────────────────────────────────────┐│
│  │ [Broker Dropdown ▼]                    ●            ││
│  │                                                     ││
│  │ [Subscribe] [Publish]                               ││
│  │ ┌─────────────────────────────────────────────────┐ ││
│  │ │ Topic: test/#                    [Subscribe]    │ ││
│  │ └─────────────────────────────────────────────────┘ ││
│  │ Messages:                                           ││
│  │ [12:34:56] test/message: Hello!                     ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Status Indicators:**
- ● Green = Connected
- ● Blue (spinning) = Connecting
- ● Red = Error
- ● Gray = Disconnected

---

## 5. Component Patterns

### 5.1 Cards
- Used for: Flow cards, settings sections, dialogs
- Consistent padding and rounded corners
- Optional header with title/description
- Footer for actions

### 5.2 Empty States
- Centered icon (muted)
- Title + description
- Optional CTA button

### 5.3 Loading States
- Spinner animation
- Optional skeleton placeholders for cards

### 5.4 Error States
- Red-tinted icon
- Error title + message
- Retry action when applicable

### 5.5 Dialogs
- Modal overlay with backdrop blur
- Header: Title + Description
- Content area
- Footer: Cancel + Primary action

### 5.6 Forms
- Field groups with consistent spacing
- Labels above inputs
- Input groups with optional icons
- Inline validation errors

---

## 6. Interaction Patterns

### 6.1 Keyboard Shortcuts
| Action | Mac | Windows |
|--------|-----|---------|
| Add node | ⌘K | Ctrl+K |
| Zoom in | ⌘+ | Ctrl++ |
| Zoom out | ⌘- | Ctrl+- |
| Zoom to fit | Shift+1 | Shift+1 |
| Zoom 100% | ⌘0 | Ctrl+0 |
| Undo | ⌘Z | Ctrl+Z |
| Redo | ⌘⇧Z | Ctrl+Shift+Z |
| Copy | ⌘C | Ctrl+C |
| Paste | ⌘V | Ctrl+V |
| Select all | ⌘A | Ctrl+A |

### 6.2 Drag & Drop
- Nodes can be dragged on canvas
- New nodes follow cursor after selection
- Press Escape to cancel placement

### 6.3 Connection Drawing
- Click and drag from output handle
- Drop on compatible input handle
- Animated edge appears on connection

---

## 7. Responsive Behavior

### Breakpoints (Tailwind defaults)
- `sm`: 640px
- `md`: 768px
- `lg`: 1024px
- `xl`: 1280px

### Grid Adaptations
- Flow cards: 1 → 2 → 3 → 4 columns
- Sidebar: Collapsible to icon-only mode

### Mobile Considerations
- `useIsMobile()` hook for detection
- Some features may be limited on mobile

---

## 8. Accessibility Notes

- Keyboard navigation throughout
- Focus indicators on interactive elements
- ARIA labels on icon-only buttons
- Color contrast compliance
- Screen reader support for flow operations

---

## 9. Animation & Transitions

- **Duration:** 250ms for most transitions
- **Easing:** Default ease curves
- **Hover states:** Scale transforms (1.05-1.1x)
- **Selected states:** Ring indicators
- **Loading:** Spin animations
- **Cursors:** Smooth position transitions (10ms)

---

## 10. Design Tokens Reference

### Node Groups
- `hardware` - Physical components
- `flow` - Logic and control
- `external` - IoT/network
- `internal` - System (hidden from users)

### Node Tags
- `digital`, `analog` - Signal types
- `input`, `output` - Data direction
- `event`, `generator` - Timing
- `transformation`, `control` - Processing
- `information` - Display/debug

---

## 11. File References

| Component | Location |
|-----------|----------|
| UI Components | `apps/web/src/components/ui/` |
| Flow Components | `apps/web/src/components/flow/` |
| Node Types | `apps/web/src/components/flow/nodes/` |
| Dialogs | `apps/web/src/components/flow/dialogs/` |
| Panels | `apps/web/src/components/flow/panels/` |
| Routes/Pages | `apps/web/src/routes/` |
| Stores (State) | `apps/web/src/stores/` |
| Hooks | `apps/web/src/hooks/` |

---

*Document generated for Microflow design handover. Last updated: January 2026*
