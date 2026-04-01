# Implementation Plan: Penpot Plugin

## Overview

Port the existing Figma plugin (`apps/figma-plugin`) to a Penpot plugin at `apps/penpot-plugin`. The implementation uses React + Vite + Tailwind CSS + Zustand for the UI iframe and the `penpot` global object in the plugin sandbox. The build system uses Vite with dual entry points (IIFE plugin bundle + React UI app). Storage uses `localStorage` directly in the UI instead of Figma's `clientStorage` in the sandbox.

## Tasks

- [x] 1. Scaffold project structure and build configuration
  - [x] 1.1 Create `apps/penpot-plugin/package.json` with dependencies
    - Add `react`, `react-dom`, `zustand`, `lucide-react`, `@microflow/mqtt` as dependencies
    - Add `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@penpot/plugin-types`, `typescript` as devDependencies
    - Add `build` and `dev` scripts using Vite
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x] 1.2 Create Vite config with dual entry points
    - Configure plugin entry (`src/plugin/plugin.ts`) as IIFE build outputting to `dist/plugin.js`
    - Configure UI entry (`src/ui/index.html`) as standard React app outputting to `dist/ui/`
    - Copy `manifest.json` to `dist/` during build
    - _Requirements: 11.3_

  - [x] 1.3 Create `manifest.json` with Penpot plugin metadata
    - Declare plugin name "Microflow hardware bridge", description, code entry, icon, and permissions
    - Set permissions: `content:read`, `content:write`, `allow:localstorage`
    - _Requirements: 1.1, 1.2_

  - [x] 1.4 Create `tsconfig.json` and Tailwind CSS config
    - Configure TypeScript with `@penpot/plugin-types` for the sandbox global
    - Set up Tailwind CSS v4 with dark mode support
    - _Requirements: 11.5, 11.7_

  - [x] 1.5 Create UI entry point `src/ui/index.html` and `src/ui/main.tsx`
    - Create minimal HTML shell for Vite
    - Create React root mount in `main.tsx`
    - Import global CSS with Tailwind directives
    - _Requirements: 1.4, 11.4_

- [x] 2. Implement message passing layer
  - [x] 2.1 Create `src/common/messages.ts` with Penpot-adapted message types
    - Define `MSG` constants: `UI_READY`, `GET_LOCAL_STATE`, `SET_LOCAL_STATE`, `SHOW_TOAST`, `OPEN_LINK`, `GET_DESIGN_TOKENS`, `SET_DESIGN_TOKEN`
    - Define `Message` discriminated union type with typed payloads per message type
    - Create factory functions for each message type
    - Create `sendToPlugin()` using `parent.postMessage()` and `sendToUI()` using `penpot.ui.sendMessage()`
    - Create `createMessageRouter()` with try-catch error handling and unrecognized type warning
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 2.2 Create `src/common/mqtt-topics.ts` with Penpot token ID helpers
    - Implement `shortTokenId()` encoding slashes as dashes for MQTT topic safety
    - Implement `fullTokenId()` reversing the encoding
    - _Requirements: 6.3_

  - [ ]* 2.3 Write unit tests for message factory functions and mqtt-topics helpers
    - Test that each factory produces correct `{ type, payload }` shape
    - Test `shortTokenId` / `fullTokenId` round-trip consistency
    - _Requirements: 2.1, 2.2, 6.3_

- [x] 3. Implement plugin sandbox
  - [x] 3.1 Create `src/plugin/plugin.ts` entry point
    - Call `penpot.ui.open()` with name, URL, and dimensions (275×190)
    - Register `penpot.ui.onMessage()` handler dispatching through `createMessageRouter`
    - Handle `UI_READY`, `SHOW_TOAST`, `OPEN_LINK`, `GET_LOCAL_STATE`, `SET_LOCAL_STATE`, `GET_DESIGN_TOKENS`, `SET_DESIGN_TOKEN`
    - Listen for `themechange` event and forward theme to UI
    - _Requirements: 1.3, 2.4, 2.6, 3.2_

  - [x] 3.2 Create `src/plugin/handlers/design-tokens.ts`
    - Implement `getDesignTokens()` reading tokens from `penpot.library.local` and flattening the hierarchy
    - Map each token to `{ path, name, type, value }` interface
    - Implement `setDesignToken(path, value)` to update a token value via the Penpot API
    - Implement value type mapping functions (`toBooleanOrNull`, `toFloatOrNull`, `toStringOrNull`, `toRgbaOrNull`)
    - Send toast notification on invalid value with token name
    - _Requirements: 6.1, 6.5, 6.7_

  - [x] 3.3 Create `src/plugin/handlers/storage.ts`
    - Implement `getLocalState()` and `setLocalState()` handlers
    - For Penpot, these relay localStorage operations back to the UI via messages (keeping protocol consistent with Figma plugin)
    - Include deep merge utility for state updates
    - _Requirements: 3.2, 3.3, 8.1, 8.2_

- [x] 4. Checkpoint - Ensure sandbox and message layer compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement UI state management and hooks
  - [x] 5.1 Create `src/ui/stores/app.ts` Zustand store
    - Define `AppState` with `pluginReady`, `mqttConfig`, `darkMode`, and their setters
    - Export `APP_STATE_KEY` constant for localStorage persistence
    - _Requirements: 8.2, 11.6_

  - [x] 5.2 Create `src/ui/hooks/use-message-listener.ts`
    - Port from Figma plugin, replacing `preact/hooks` with `react` imports
    - Listen for `message` events on `window`, filter by message type
    - Support optional polling interval and initial send
    - _Requirements: 2.3, 2.4_

  - [x] 5.3 Create `src/ui/hooks/use-navigation.ts`
    - Port Zustand-based navigation store from Figma plugin
    - Support `home`, `mqtt`, `variables` pages with history stack and `goBack`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 5.4 Create `src/ui/hooks/use-copy-to-clipboard.ts`
    - Port from Figma plugin, replacing `preact/hooks` with `react` imports
    - Use `navigator.clipboard` with textarea fallback
    - Show toast notification on copy via `sendToPlugin`
    - _Requirements: 7.3, 7.4, 7.5, 7.6_

- [x] 6. Implement UI pages and components
  - [x] 6.1 Create `src/ui/components/PageLayout.tsx`
    - Port `PageHeader` and `PageContent` from Figma plugin
    - Replace Figma UI components with Tailwind-styled HTML elements
    - Use `useNavigation` hook for back button
    - Style with Tailwind CSS, supporting dark mode via class strategy
    - _Requirements: 10.3, 10.4_

  - [x] 6.2 Create `src/ui/pages/Home.tsx`
    - Display MQTT connection status with colored dot indicator (green/amber/red/gray)
    - Display Microflow Studio connection status
    - Add navigation buttons to MQTT settings and variables pages
    - Add external link to Microflow Studio
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 6.3 Create `src/ui/pages/MqttSettings.tsx`
    - Port form with fields for broker URL, username, password, unique identifier
    - Validate broker URL with `mqttUrlSchema` from `@microflow/mqtt`
    - Validate unique identifier (min 5 chars, letters and underscores only)
    - Add random name generator button
    - Save config to localStorage and Zustand store on submit
    - Replace Figma UI components (`Textbox`, `Button`) with Tailwind-styled HTML inputs/buttons
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 6.4 Create `src/ui/pages/Variables.tsx`
    - Display list of design tokens with name and type icon
    - Add copy buttons for publish topic, subscribe topic, and prototype link per token
    - Show checkmark icon on successful copy
    - Display empty state when no tokens found
    - Use `shortTokenId` for MQTT topic construction
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

- [x] 7. Implement App shell with lifecycle, theme, and MQTT wiring
  - [x] 7.1 Create `src/ui/App.tsx` with plugin handshake
    - Send `UI_READY` on mount, listen for ack, then hydrate state from localStorage
    - Read persisted state directly from `localStorage` (no sandbox round-trip needed)
    - Auto-connect MQTT when config is available via `useMqttStore.connect()`
    - Wire up client-side router rendering Home/MqttSettings/Variables
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 8.2, 8.3, 8.4_

  - [x] 7.2 Implement dark mode sync with Penpot theme
    - Listen for messages from sandbox forwarding `themechange` events
    - Toggle `dark` class on `document.documentElement` based on `penpot.theme`
    - Set initial theme on handshake
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 7.3 Create `src/ui/components/MqttVariableMessenger.ts`
    - Port headless MQTT↔token bridge from Figma plugin
    - Poll sandbox for design tokens at 250ms interval via `useMessageListener`
    - Publish token list to `microflow/{uniqueId}/plugin/variables`
    - Publish individual token values to `microflow/{uniqueId}/plugin/variable/{tokenId}`
    - Subscribe to `microflow/{uniqueId}/+/variable/+/set` for inbound updates
    - Subscribe to `microflow/{uniqueId}/+/variables/request` for variable requests
    - Deduplicate publishes using ref-based value cache
    - Use `shortTokenId`/`fullTokenId` instead of Figma's `shortVarId`/`fullVarId`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 8. Checkpoint - Ensure full UI compiles and renders
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integration and final wiring
  - [x] 9.1 Wire localStorage persistence for MQTT config
    - On settings save, write to `localStorage` under `APP_STATE_KEY`
    - On plugin init, read from `localStorage` and hydrate Zustand store
    - Handle missing or corrupt localStorage data gracefully
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 9.2 Add global CSS with Tailwind and dark mode theme variables
    - Create `src/ui/index.css` with Tailwind directives
    - Define CSS custom properties for light/dark themes matching Penpot's palette
    - _Requirements: 9.1, 9.2, 11.5_

  - [ ]* 9.3 Write unit tests for design token handler value mapping
    - Test `toBooleanOrNull` with boolean, string, number inputs
    - Test `toFloatOrNull` with valid/invalid number strings
    - Test `toStringOrNull` with various types
    - Test `toRgbaOrNull` with color string and object inputs
    - _Requirements: 6.5, 6.7_

  - [ ]* 9.4 Write unit tests for localStorage persistence
    - Test state hydration from valid localStorage data
    - Test graceful handling of empty/corrupt localStorage
    - Test config save and read round-trip
    - _Requirements: 8.1, 8.2, 8.4_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The Figma plugin at `apps/figma-plugin/src/` serves as the reference implementation for porting
- Key adaptations: Preact → React, `figma` global → `penpot` global, Figma Variables → Penpot Design Tokens, `clientStorage` → `localStorage`, `build-figma-plugin` → Vite dual-entry
- The `@microflow/mqtt` package is reused as-is from the workspace
