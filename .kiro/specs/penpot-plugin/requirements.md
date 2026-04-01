# Requirements Document

## Introduction

The Penpot Plugin is a Microflow Hardware Bridge (MHB) plugin for Penpot, the open-source design platform. It mirrors the functionality of the existing Figma plugin (`apps/figma-plugin`), enabling designers to bridge Penpot design tokens and component data to hardware prototypes via MQTT. The plugin runs as an externally-hosted iframe application, communicates with the Penpot host via `postMessage`, and reuses the shared `@microflow/mqtt` workspace package for all MQTT operations.

The plugin lives at `apps/penpot-plugin` in the monorepo and is built with React, Vite, Zustand, and Tailwind CSS.

## Glossary

- **Plugin_Sandbox**: The plugin entry point script (`plugin.ts`) that has access to the Penpot API via the global `penpot` object. This is the only context where Penpot API calls can be made.
- **Plugin_UI**: The iframe-hosted React application that renders the user interface. It communicates with the Plugin_Sandbox via `postMessage`.
- **Message_Router**: A type-safe message passing layer between the Plugin_Sandbox and Plugin_UI, using discriminated unions and factory functions.
- **MQTT_Broker**: An external MQTT server that the plugin connects to for publishing and subscribing to messages.
- **MHB_Collection**: A named group of design variables/tokens in the design tool (named "MHB") that the plugin reads from and writes to.
- **Design_Token**: A Penpot design token (boolean, string, number, or color) that represents a bridgeable variable.
- **Unique_Identifier**: A user-configured string (minimum 5 characters, letters and underscores only) that namespaces all MQTT topics for a given plugin instance.
- **Connected_Client**: Another MQTT client (such as Microflow Studio) that shares the same Unique_Identifier and communicates over the same MQTT topic namespace.
- **Plugin_Manifest**: A `manifest.json` file that declares the plugin name, description, entry points, icon, and required Penpot permissions.
- **Local_Storage**: Browser localStorage used by the Plugin_UI to persist MQTT configuration and app state across sessions (via the `allow:localstorage` Penpot permission).

## Requirements

### Requirement 1: Plugin Manifest and Hosting

**User Story:** As a Penpot user, I want to install the Microflow Hardware Bridge plugin via a manifest URL, so that I can use it within my Penpot workspace.

#### Acceptance Criteria

1. THE Plugin_Manifest SHALL declare the plugin name as "Microflow hardware bridge", a description, the plugin code entry point, an icon, and the required permissions.
2. THE Plugin_Manifest SHALL request the following permissions: `content:read`, `content:write`, `allow:localstorage`.
3. THE Plugin_Sandbox SHALL register the plugin UI panel using the Penpot plugin API when the plugin code entry point is executed.
4. WHEN the plugin is installed via its manifest URL, THE Plugin_UI SHALL load and render within a Penpot panel iframe.

### Requirement 2: Plugin Sandbox and UI Communication

**User Story:** As a developer, I want type-safe message passing between the plugin sandbox and the UI iframe, so that communication is reliable and maintainable.

#### Acceptance Criteria

1. THE Message_Router SHALL define a set of message types as a discriminated union with typed payloads for each message type.
2. THE Message_Router SHALL provide factory functions for constructing each message type.
3. WHEN the Plugin_UI sends a message, THE Message_Router SHALL deliver the message to the Plugin_Sandbox via `postMessage`.
4. WHEN the Plugin_Sandbox sends a message, THE Message_Router SHALL deliver the message to the Plugin_UI via the Penpot plugin messaging API.
5. THE Message_Router SHALL support the following message categories: lifecycle handshake, local storage operations, design token operations, and UI notifications.
6. IF the Plugin_Sandbox receives a message with an unrecognized type, THEN THE Message_Router SHALL log a warning and continue operation without crashing.

### Requirement 3: Plugin Lifecycle Handshake

**User Story:** As a user, I want the plugin to initialize reliably, so that I can start using it without manual intervention.

#### Acceptance Criteria

1. WHEN the Plugin_UI finishes loading, THE Plugin_UI SHALL send a UI_READY message to the Plugin_Sandbox.
2. WHEN the Plugin_Sandbox receives the UI_READY message, THE Plugin_Sandbox SHALL respond with a UI_READY acknowledgment message.
3. WHEN the Plugin_UI receives the UI_READY acknowledgment, THE Plugin_UI SHALL request persisted state from Local_Storage.
4. WHEN persisted state is retrieved from Local_Storage, THE Plugin_UI SHALL hydrate the application state store with the persisted MQTT configuration.

### Requirement 4: MQTT Connection Management

**User Story:** As a maker, I want to configure and connect to an MQTT broker from within Penpot, so that I can bridge my design tokens to hardware.

#### Acceptance Criteria

1. THE Plugin_UI SHALL display a settings page with input fields for broker URL, username (optional), password (optional), and Unique_Identifier.
2. THE Plugin_UI SHALL validate the broker URL using the `mqttUrlSchema` from the `@microflow/mqtt` package.
3. THE Plugin_UI SHALL validate that the Unique_Identifier contains a minimum of 5 characters and only letters and underscores.
4. THE Plugin_UI SHALL provide a button to generate a random Unique_Identifier in the format `{adjective}_{animal}`.
5. WHEN the user submits valid MQTT settings, THE Plugin_UI SHALL store the configuration in Local_Storage for persistence across sessions.
6. WHEN the user submits valid MQTT settings, THE Plugin_UI SHALL initiate an MQTT connection using the `useMqttStore.connect()` method from the `@microflow/mqtt` package.
7. IF the broker URL fails validation, THEN THE Plugin_UI SHALL display an inline error message below the broker URL field.
8. IF the Unique_Identifier fails validation, THEN THE Plugin_UI SHALL display an inline error message below the Unique_Identifier field.

### Requirement 5: Connection Status Display

**User Story:** As a maker, I want to see the connection status of MQTT and Microflow Studio at a glance, so that I know whether my hardware bridge is active.

#### Acceptance Criteria

1. THE Plugin_UI SHALL display the MQTT connection status on the home page using a colored status indicator (green for connected, amber for connecting, red for disconnected, gray for not configured).
2. THE Plugin_UI SHALL display the Microflow Studio connection status on the home page using the same colored status indicator pattern.
3. WHEN the MQTT connection status changes, THE Plugin_UI SHALL update the status indicator within the current render cycle.
4. THE Plugin_UI SHALL provide a navigation button from the home page to the MQTT settings page.
5. THE Plugin_UI SHALL provide a navigation button from the home page to the variables list page.
6. THE Plugin_UI SHALL provide a link to open the Microflow Studio web application in a new browser tab.

### Requirement 6: Design Token Bridge

**User Story:** As a maker, I want the plugin to read design tokens from Penpot and publish them over MQTT, so that external hardware and applications can react to design changes.

#### Acceptance Criteria

1. WHEN the MQTT connection status is "connected", THE Plugin_Sandbox SHALL read design tokens from the active Penpot file.
2. THE Plugin_Sandbox SHALL publish the list of known design tokens to the MQTT topic `microflow/{uniqueId}/plugin/variables` as a JSON object.
3. THE Plugin_Sandbox SHALL publish each design token value to the MQTT topic `microflow/{uniqueId}/plugin/variable/{tokenId}` as a JSON string.
4. WHEN a design token value changes, THE Plugin_Sandbox SHALL publish only the changed value, skipping tokens whose values have not changed since the last publish.
5. WHEN the plugin receives an MQTT message on the topic `microflow/{uniqueId}/+/variable/+/set`, THE Plugin_Sandbox SHALL update the corresponding design token in Penpot with the received value.
6. WHEN the plugin receives an MQTT message on the topic `microflow/{uniqueId}/+/variables/request`, THE Plugin_Sandbox SHALL respond by publishing the current token list and all token values to the requesting client's topic namespace.
7. IF the plugin receives an invalid value for a design token type, THEN THE Plugin_Sandbox SHALL display a notification to the user describing the invalid value and the target token name.

### Requirement 7: Design Token List View

**User Story:** As a maker, I want to see all bridged design tokens with their types and copy MQTT topics, so that I can integrate them into my hardware flows.

#### Acceptance Criteria

1. THE Plugin_UI SHALL display a list of all design tokens read from the active Penpot file on the variables page.
2. THE Plugin_UI SHALL display each design token with its name and a type indicator icon (boolean, string, number, or color).
3. THE Plugin_UI SHALL provide a copy-to-clipboard button for the MQTT publish topic of each design token.
4. THE Plugin_UI SHALL provide a copy-to-clipboard button for the MQTT subscribe topic of each design token.
5. THE Plugin_UI SHALL provide a copy-to-clipboard button for the prototype link of each design token.
6. WHEN a copy button is clicked, THE Plugin_UI SHALL display a visual confirmation (checkmark icon) for the copied item.
7. WHEN no design tokens are found, THE Plugin_UI SHALL display an empty state message explaining how to create bridgeable tokens.

### Requirement 8: Persistent State

**User Story:** As a user, I want my MQTT configuration to persist across sessions, so that I do not have to re-enter settings every time I open the plugin.

#### Acceptance Criteria

1. WHEN the user saves MQTT settings, THE Plugin_UI SHALL persist the configuration to Local_Storage using the `allow:localstorage` permission.
2. WHEN the plugin initializes, THE Plugin_UI SHALL read persisted state from Local_Storage and restore the MQTT configuration.
3. WHEN persisted state contains a valid MQTT configuration, THE Plugin_UI SHALL automatically initiate an MQTT connection on startup.
4. IF Local_Storage is empty or contains invalid data, THEN THE Plugin_UI SHALL start with default empty state without errors.

### Requirement 9: Dark Mode Support

**User Story:** As a user, I want the plugin UI to match the Penpot application theme, so that the visual experience is consistent.

#### Acceptance Criteria

1. WHEN the Penpot host application is using a dark theme, THE Plugin_UI SHALL render with a dark color scheme.
2. WHEN the Penpot host application is using a light theme, THE Plugin_UI SHALL render with a light color scheme.
3. WHEN the Penpot theme changes while the plugin is open, THE Plugin_UI SHALL update its color scheme to match within the current render cycle.

### Requirement 10: Client-Side Navigation

**User Story:** As a user, I want to navigate between the home, settings, and variables pages within the plugin, so that I can access all features without reloading.

#### Acceptance Criteria

1. THE Plugin_UI SHALL support navigation between three pages: home, MQTT settings, and variables list.
2. THE Plugin_UI SHALL maintain a navigation history stack.
3. WHEN the user is on a page other than home, THE Plugin_UI SHALL display a back button that returns to the previous page.
4. WHEN the back button is pressed, THE Plugin_UI SHALL navigate to the most recent page in the history stack.

### Requirement 11: Monorepo Integration

**User Story:** As a developer, I want the Penpot plugin to follow the existing monorepo conventions, so that it integrates cleanly with the build system and shared packages.

#### Acceptance Criteria

1. THE Plugin_Sandbox SHALL reside at `apps/penpot-plugin` in the monorepo directory structure.
2. THE Plugin_Sandbox SHALL declare `@microflow/mqtt` as a workspace dependency for all MQTT functionality.
3. THE Plugin_Sandbox SHALL use Vite as the build tool for both the plugin entry point and the UI iframe application.
4. THE Plugin_UI SHALL use React for rendering the user interface.
5. THE Plugin_UI SHALL use Tailwind CSS for styling.
6. THE Plugin_UI SHALL use Zustand for client-side state management, consistent with the rest of the Microflow project.
7. THE Plugin_Sandbox SHALL declare `@penpot/plugin-types` as a dev dependency for TypeScript type definitions of the Penpot plugin API.
