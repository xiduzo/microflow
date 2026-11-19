//! The backoff of the MQTT reconnect: `ReconnectConfig::next_delay`, as a
//! property over its parameters.
//!
//! The reconnect loop itself — that it repairs a dropped link, re-subscribes,
//! gives a silent broker up in time, and stops after the attempts it was
//! allowed — is tested against a socket, in `mqtt_pool.rs`.

use proptest::prelude::*;
use std::time::Duration;

use app_lib::mqtt::broker::ReconnectConfig;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // For any `ReconnectConfig` and any run of N failed attempts, the delay
    // before attempt N is min(initial_delay × multiplier^(N-1), max_delay).
    #[test]
    fn delay_calculation_respects_bounds(
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120_000,
        multiplier in 1.5f64..3.0,
        attempts in 1usize..20
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: None,
            ..ReconnectConfig::default()
        };

        let mut delay = config.initial_delay;
        for _ in 1..attempts {
            delay = config.next_delay(delay);
        }

        // Verify delay never exceeds max_delay
        prop_assert!(delay <= config.max_delay,
            "Delay {:?} exceeded max_delay {:?}", delay, config.max_delay);

        // Verify delay follows formula (within floating point tolerance)
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
        let expected = (initial_ms as f64 * multiplier.powi((attempts - 1) as i32))
            .min(max_ms as f64);
        #[allow(clippy::cast_precision_loss)]
        let actual = delay.as_millis() as f64;
        prop_assert!((actual - expected).abs() < 1.0,
            "Delay mismatch: expected {} ms, got {} ms (diff: {})",
            expected, actual, (actual - expected).abs());
    }
}
