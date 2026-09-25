// The Firmata handshake as a sans-IO state machine.
//
// `tryConnectAtBaud` used to interleave this policy with `port.open`,
// `reader.getReader` and `sleep`: two deadline-polling loops, a requery cadence
// and a give-up rule, none of which could be tested without a live board and a
// real clock. The decisions move here — a pure `advance(state, now, observed)`
// — and `web-serial.ts` is left performing the actions, the same split
// `microflow_core::bringup` already uses for the phase above this one.
//
// Deliberately not (yet) shared with the desktop. The desktop runs its own
// handshake in `src-tauri/src/hardware/firmata.rs` with a different cadence
// (three attempts with fixed sleeps, rather than a deadline with a requery
// interval); only `BAUD_RATES` and the reset timings below are genuinely the
// same policy in two languages. See the note on those constants.

/**
 * Baud rates to try, in order. StandardFirmata's own default is 57600, so it
 * comes first; 115200 is what most third-party sketches and boards ship with.
 *
 * DUPLICATED: `find_firmata_baud` in `src-tauri/src/hardware/firmata.rs` has the
 * same list in the same order. Changing one without the other makes a board
 * connect in one host and not the other.
 */
export const BAUD_RATES = [57600, 115200] as const;

/**
 * DTR/RTS reset: hold the lines low, then let the board boot.
 *
 * DUPLICATED: `reset_board` in `src-tauri/src/hardware/firmata.rs` uses the same
 * two durations. They are a property of the board's auto-reset circuit, not of
 * the host.
 */
export const RESET_PULSE_MS = 250;
export const RESET_SETTLE_MS = 1500;

/** How long to keep asking for the firmware name before giving up on this baud. */
export const FIRMWARE_TIMEOUT_MS = 6000;
/** How often to re-send the firmware query while waiting — a board still booting
 *  misses the first one, and StandardFirmata does not re-announce itself. */
export const FIRMWARE_REQUERY_MS = 1000;
/** How long to wait for the capability response that sizes the pin table. */
export const CAPABILITY_TIMEOUT_MS = 2000;
/** Gap between checks of the decoded session. */
export const POLL_MS = 100;

export type HandshakePhase = "firmware" | "capabilities";

export interface HandshakeState {
  phase: HandshakePhase;
  /** When the current phase gives up (ms, same clock as `now`). */
  deadline: number;
  /** When the firmware query was last sent. */
  lastQueryAt: number;
}

export type HandshakeAction =
  /** Write a firmware query, then call `advance` again. */
  | { kind: "sendFirmwareQuery" }
  /** Write the capability + analog-mapping queries, then call `advance` again. */
  | { kind: "sendCapabilityQueries" }
  /** Nothing to do yet; wait this long and call `advance` again. */
  | { kind: "poll"; delayMs: number }
  /** The handshake succeeded — keep the connection. */
  | { kind: "connected" }
  /** No Firmata at this baud — tear down and let the caller try the next. */
  | { kind: "noFirmata" };

/** What the driver can see of the decoded session, sampled per step. */
export interface HandshakeObservation {
  /** `""` until the firmware response has been decoded. */
  firmwareName: string;
  /** `0` until the capability response has sized the pin table. */
  pinCount: number;
}

/**
 * Begin a handshake at `now`.
 *
 * `lastQueryAt` starts infinitely far in the past so the very first `advance`
 * sends the firmware query — the initial send is the same decision as every
 * requery, not a special case the driver has to remember.
 */
export function startHandshake(now: number): HandshakeState {
  return {
    phase: "firmware",
    deadline: now + FIRMWARE_TIMEOUT_MS,
    lastQueryAt: Number.NEGATIVE_INFINITY,
  };
}

/**
 * One step. Pure: same state + clock + observation gives the same action.
 *
 * The two phases differ in what a timeout means, which is the rule most easily
 * lost when this is written inline. No firmware by the deadline means there is
 * no Firmata here, so the caller should try the next baud. No capability
 * response by the deadline is *not* fatal — the firmware already answered, so
 * the board is real; it connects with whatever pin table arrived, and the
 * runtime is seeded separately.
 */
export function advance(
  state: HandshakeState,
  now: number,
  observed: HandshakeObservation,
): { state: HandshakeState; action: HandshakeAction } {
  if (state.phase === "firmware") {
    if (observed.firmwareName !== "") {
      return {
        state: {
          phase: "capabilities",
          deadline: now + CAPABILITY_TIMEOUT_MS,
          lastQueryAt: now,
        },
        action: { kind: "sendCapabilityQueries" },
      };
    }
    if (now >= state.deadline) {
      return { state, action: { kind: "noFirmata" } };
    }
    if (now - state.lastQueryAt >= FIRMWARE_REQUERY_MS) {
      return { state: { ...state, lastQueryAt: now }, action: { kind: "sendFirmwareQuery" } };
    }
    return { state, action: { kind: "poll", delayMs: POLL_MS } };
  }

  if (observed.pinCount > 0 || now >= state.deadline) {
    return { state, action: { kind: "connected" } };
  }
  return { state, action: { kind: "poll", delayMs: POLL_MS } };
}
