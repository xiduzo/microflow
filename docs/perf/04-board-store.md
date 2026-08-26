# Board store: pin subscriptions

The board store (`apps/web/src/stores/board.ts`) is the single place the editor reads
microcontroller state from. Every node that renders a pin selector or a pin label
subscribes to it, so its notification behaviour decides how much of the canvas re-renders
when the board talks.

## Shape

`BoardStoreState` (`stores/board.ts:11-17`) holds three fields:

| field | meaning |
| --- | --- |
| `board` | the raw `board-state` payload (`BoardState` tagged union, generated from Rust) |
| `pins` | the connected board's `Pin[]`, or the shared empty `NO_PINS` array when not connected |
| `pinsIdentity` | the value fingerprint of `pins` (`stores/board.ts:26-28`) |

`pins` and `pinsIdentity` are derived; only `setBoard` writes them.

## The equality contract

The `board-state` Tauri event is deserialized fresh on every emission, so its `Pin[]` and
every `PinInfo` inside it are new objects each time. Reference equality is therefore
useless, and a shallow (element-by-reference) comparison never matches either.

`pinsIdentity(pins)` (`stores/board.ts:26-28`) reduces the list to a string built from the
fields a node can act on — `pin`, `analogChannel`, and `supportedModes`:

```
"3:127:1.3|4:127:0.11"
```

`setBoard` (`stores/board.ts:37-48`) compares that fingerprint against the stored one:

- **fingerprint unchanged** — `state.pins` keeps its previous reference, and the incoming
  `board` object is rewritten with that same array before it is stored, so `board.pins`
  and `state.pins` are always the same array.
- **fingerprint changed** — `board`, `pins`, and `pinsIdentity` are all replaced.

The resulting contract: **`state.pins` changes identity if and only if pin identity
changed.** A subscriber selecting `state.pins` is notified only by a real pin change, not
by a reconnect, a port change, or a repeated identical board frame.

## Subscribing to pins

Use `usePins` (`stores/board.ts:70-89`):

```tsx
const pins = usePins([MODES.OUTPUT, MODES.PWM]);        // pins supporting both modes
const pins = usePins([MODES.OUTPUT], [MODES.ANALOG]);   // ...and not analog
const pins = usePins();                                 // every pin
```

The first argument lists modes a pin must support; the optional second lists modes it must
not. Inline array literals are the intended call style — the internal `useMemo` is keyed on
`shouldHaveMode.join(",")` / `shouldNotHaveMode.join(",")`, i.e. on the *contents* of the
mode arrays, so a fresh literal per render does not re-run the filter. The mode arrays are
reconstructed from those keys inside the memo, so the filter can never close over a stale
argument.

Callers may compute the modes conditionally
(`components/flow/nodes/button/button.tsx:40` switches on whether a pullup is required);
the key changes with the modes and the filter re-runs exactly then.

With no required modes, `usePins()` returns the store array itself, so its result is
reference-stable too.

Other selectors: `useBoardPort`, `useBoardState`, `useBoardError`, `useBoard`
(`stores/board.ts:91-99`). Because `board.pins` is canonicalised, `useBoard()`'s shallow
guard also holds across identical frames.

## Invariants

1. `pins` and `pinsIdentity` are written together and only by `setBoard`. Any new writer
   must recompute the fingerprint or the contract silently breaks — subscribers would then
   wake on every board event again.
2. `pinsIdentity` must cover every `PinInfo` field a consumer reads. Adding a field to
   `lib/bindings/PinInfo.ts` (generated from Rust) means adding it to `pinsIdentity`,
   otherwise changes to it never reach the UI.
3. `NO_PINS` (`stores/board.ts:19`) is shared and must never be mutated; a disconnected
   board hands the same array to every caller.
4. Selectors returning `pins` must stay plain (`useBoardStore((s) => s.pins)`). Wrapping
   them in `useShallow` would re-introduce an element-by-reference comparison that costs
   work without changing the outcome.
5. `usePins` must key its memo on the mode *contents*, never on the array props, so inline
   literals stay free.

Covered by `apps/web/src/stores/__tests__/board.test.ts`.
