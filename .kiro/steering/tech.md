# Technology Stack

## Build System & Package Management
- **Package Manager**: Yarn 3.8.7 with workspaces
- **Node Version**: 20.13.1
- **Monorepo**: Yarn workspaces with apps/* and packages/* structure
- **Patch Management**: patch-package for dependency modifications

## Core Technologies

### Microflow Studio (Electron App)
- **Framework**: Electron 37.1.0 with Vite build system
- **UI**: React 18.3.1 + TypeScript 5.8.3
- **Styling**: TailwindCSS 3.4.17 + PostCSS
- **State Management**: Zustand 5.0.3
- **Flow Interface**: @xyflow/react 12.5.1
- **Hardware Communication**: 
  - Firmata.js (custom fork)
  - SerialPort 12.0.0
  - MQTT 5.10.4
- **Testing**: Jest 30.0.5 + ts-jest

### Microflow Hardware Bridge (Figma Plugin)
- **Framework**: Vite + TypeScript
- **UI**: React 18.3.1 + React Router DOM
- **Build**: Dual build system (UI + Plugin)
- **Communication**: MQTT client for hardware bridge

### Documentation Site (Next.js)
- **Framework**: Next.js 14.2.14
- **Content**: Markdoc for documentation
- **Styling**: TailwindCSS + Typography plugin
- **Search**: FlexSearch + Algolia Autocomplete
- **Analytics**: Vercel Analytics

## Shared Packages
- **@microflow/ui**: Radix UI + shadcn/ui component library
- **@microflow/components**: Hardware abstraction layer with Johnny-Five
- **@microflow/flasher**: Firmware flashing utilities (AVR, STK500)
- **@microflow/mqtt-provider**: MQTT communication layer
- **@microflow/socket**: WebSocket communication
- **@microflow/utils**: Shared utilities

## Key Dependencies
- **Hardware**: johnny-five, chip.avr.avr109, stk500, intel-hex
- **AI/ML**: LangChain + Ollama integration
- **UI Components**: Radix UI primitives, Recharts, Leva controls
- **Development**: Concurrently for parallel processes

## Common Commands

### Development
```bash
# Start main development environment
yarn dev

# Start Figma plugin development
yarn dev:plugin

# Install dependencies
yarn install

# Build all workspaces
yarn build
```

### Electron App Specific
```bash
# Start Electron app
yarn workspace microflow-studio start

# Package for distribution
yarn workspace microflow-studio make

# Publish release
yarn workspace microflow-studio publish

# Test hardware boards
yarn workspace microflow-studio test:boards
```

### Testing
```bash
# Run tests
yarn workspace microflow-studio test

# Test specific hardware components
yarn workspace @microflow/flasher test
```

## Build Configuration
- **Electron Forge**: For packaging and distribution
- **Vite**: Modern build tool for fast development
- **TypeScript**: Strict mode enabled across all packages
- **ESLint**: Code quality (React hooks rules)
- **Prettier**: Code formatting (3.4.2+)