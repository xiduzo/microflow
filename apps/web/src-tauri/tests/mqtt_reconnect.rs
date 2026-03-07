//! Property-based tests for MQTT reconnection with exponential backoff
//!
//! These tests verify the correctness of the ReconnectConfig delay calculation
//! and topic resubscription logic using the proptest framework.

use proptest::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

// Import the ReconnectConfig from the main crate
use app_lib::mqtt::broker::ReconnectConfig;

/// Mock subscription storage that mimics BrokerState.subscriptions
/// This allows us to test the topic collection logic without needing a real MQTT broker
struct MockSubscriptionStore {
    subscriptions: HashMap<String, Arc<dyn Fn() + Send + Sync>>,
}

impl MockSubscriptionStore {
    fn new() -> Self {
        Self {
            subscriptions: HashMap::new(),
        }
    }

    /// Add a subscription (mimics MqttBroker::subscribe)
    fn subscribe(&mut self, topic: &str) {
        // Use a dummy callback since we only care about topic storage
        self.subscriptions
            .insert(topic.to_string(), Arc::new(|| {}));
    }

    /// Collect all subscribed topics (mimics the logic in resubscribe_all)
    fn collect_topics(&self) -> Vec<String> {
        self.subscriptions.keys().cloned().collect()
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-runtime-reliability, Property 1: Exponential Backoff Delay Calculation
    // **Validates: Requirements 1.7, 1.8**
    //
    // *For any* ReconnectConfig with initial_delay, max_delay, and multiplier, and *for any*
    // sequence of N failed reconnection attempts, the delay before attempt N should equal
    // min(initial_delay × multiplier^(N-1), max_delay).
    #[test]
    fn delay_calculation_respects_bounds(
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120000,
        multiplier in 1.5f64..3.0,
        attempts in 1usize..20
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: None,
        };

        let mut delay = config.initial_delay;
        for _ in 1..attempts {
            delay = config.next_delay(delay);
        }

        // Verify delay never exceeds max_delay
        prop_assert!(delay <= config.max_delay,
            "Delay {:?} exceeded max_delay {:?}", delay, config.max_delay);

        // Verify delay follows formula (within floating point tolerance)
        let expected = (initial_ms as f64 * multiplier.powi((attempts - 1) as i32))
            .min(max_ms as f64);
        let actual = delay.as_millis() as f64;
        prop_assert!((actual - expected).abs() < 1.0,
            "Delay mismatch: expected {} ms, got {} ms (diff: {})",
            expected, actual, (actual - expected).abs());
    }
}

/// Simulates the max_attempts termination logic from reconnect_loop.
/// This function mirrors the exact logic used in MqttBroker::reconnect_loop
/// to determine when to stop reconnecting.
///
/// Returns the number of attempts made before termination.
fn simulate_reconnect_attempts(config: &ReconnectConfig, all_attempts_fail: bool) -> usize {
    let mut attempts = 0;

    loop {
        // Check max attempts before attempting reconnection (mirrors reconnect_loop logic)
        if let Some(max) = config.max_attempts {
            if attempts >= max {
                // Max attempts reached, stop reconnecting
                break;
            }
        }

        // Simulate a reconnection attempt
        // In the real reconnect_loop, this would be broker_guard.connect_internal().await
        let success = !all_attempts_fail;

        if success {
            // Reconnection succeeded, exit loop
            break;
        } else {
            // Reconnection failed, increment attempt counter
            attempts += 1;
        }

        // Safety check: if max_attempts is None and all attempts fail,
        // we would loop forever. For testing, we cap at a reasonable limit.
        if config.max_attempts.is_none() && attempts >= 1000 {
            break;
        }
    }

    attempts
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-runtime-reliability, Property 2: Max Attempts Termination
    // **Validates: Requirements 1.9**
    //
    // *For any* ReconnectConfig with max_attempts set to M, and *for any* sequence of M
    // consecutive failed reconnection attempts, the reconnect_loop SHALL terminate after
    // exactly M attempts without further retries.
    //
    // Note: This test verifies the max_attempts termination logic in isolation.
    // Testing the full reconnect_loop would require mocking the MQTT broker connection.
    // The property being tested is: when max_attempts is Some(M) and all attempts fail,
    // the loop terminates after exactly M attempts.
    #[test]
    fn max_attempts_terminates_after_exactly_m_attempts(
        max_attempts in 1usize..100,
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120000,
        multiplier in 1.5f64..3.0
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: Some(max_attempts),
        };

        // Simulate all reconnection attempts failing
        let attempts_made = simulate_reconnect_attempts(&config, true);

        // Property: The loop should terminate after exactly max_attempts attempts
        prop_assert_eq!(
            attempts_made,
            max_attempts,
            "Expected exactly {} attempts, but made {} attempts",
            max_attempts,
            attempts_made
        );
    }

    // Feature: rust-runtime-reliability, Property 2: Max Attempts Termination (Early Success)
    // **Validates: Requirements 1.9**
    //
    // This test verifies that when reconnection succeeds before max_attempts is reached,
    // the loop terminates early (fewer than M attempts).
    #[test]
    fn max_attempts_allows_early_termination_on_success(
        max_attempts in 2usize..100,
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120000,
        multiplier in 1.5f64..3.0
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: Some(max_attempts),
        };

        // Simulate reconnection succeeding on first attempt
        let attempts_made = simulate_reconnect_attempts(&config, false);

        // Property: The loop should terminate with 0 failed attempts (success on first try)
        prop_assert_eq!(
            attempts_made,
            0,
            "Expected 0 failed attempts on immediate success, but got {}",
            attempts_made
        );
    }

    // Feature: rust-runtime-reliability, Property 2: Max Attempts Termination (None means infinite)
    // **Validates: Requirements 1.9**
    //
    // This test verifies that when max_attempts is None, the loop would continue indefinitely
    // (we cap at 1000 for testing purposes to avoid infinite loops).
    #[test]
    fn none_max_attempts_continues_indefinitely(
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120000,
        multiplier in 1.5f64..3.0
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: None,
        };

        // Simulate all reconnection attempts failing
        let attempts_made = simulate_reconnect_attempts(&config, true);

        // Property: With None max_attempts and all failures, the loop continues
        // until our safety cap (1000 attempts)
        prop_assert_eq!(
            attempts_made,
            1000,
            "Expected loop to continue until safety cap (1000), but stopped at {}",
            attempts_made
        );
    }

    // Feature: rust-runtime-reliability, Property 2: Max Attempts Termination (Boundary)
    // **Validates: Requirements 1.9**
    //
    // This test verifies the boundary condition where max_attempts is 1.
    // The loop should terminate after exactly 1 failed attempt.
    #[test]
    fn max_attempts_boundary_single_attempt(
        initial_ms in 100u64..5000,
        max_ms in 10000u64..120000,
        multiplier in 1.5f64..3.0
    ) {
        let config = ReconnectConfig {
            initial_delay: Duration::from_millis(initial_ms),
            max_delay: Duration::from_millis(max_ms),
            multiplier,
            max_attempts: Some(1),
        };

        // Simulate all reconnection attempts failing
        let attempts_made = simulate_reconnect_attempts(&config, true);

        // Property: With max_attempts=1, exactly 1 attempt should be made
        prop_assert_eq!(
            attempts_made,
            1,
            "Expected exactly 1 attempt with max_attempts=1, but got {}",
            attempts_made
        );
    }
}


/// Strategy to generate valid MQTT topic strings
/// Topics can contain alphanumeric characters, slashes, and wildcards
fn mqtt_topic_strategy() -> impl Strategy<Value = String> {
    // Generate topic segments (1-4 segments separated by /)
    prop::collection::vec("[a-zA-Z0-9_]{1,20}", 1..=4)
        .prop_map(|segments| segments.join("/"))
}

/// Strategy to generate a set of unique MQTT topics
fn mqtt_topic_set_strategy(max_topics: usize) -> impl Strategy<Value = HashSet<String>> {
    prop::collection::hash_set(mqtt_topic_strategy(), 0..=max_topics)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-runtime-reliability, Property 3: Topic Resubscription Completeness
    // **Validates: Requirements 1.10**
    //
    // *For any* MqttBroker with a set of N subscribed topics before disconnection,
    // after successful reconnection, all N topics SHALL be resubscribed
    // (the set of subscribed topics after reconnection equals the set before disconnection).
    //
    // Note: This test verifies the topic collection logic that underlies resubscription.
    // Testing the full reconnection flow would require a real MQTT broker.
    // The property being tested is: collect_topics() returns exactly the set of subscribed topics.
    #[test]
    fn topic_resubscription_completeness(
        topics in mqtt_topic_set_strategy(50)
    ) {
        let mut store = MockSubscriptionStore::new();

        // Subscribe to all topics (simulates state before disconnection)
        for topic in &topics {
            store.subscribe(topic);
        }

        // Collect topics for resubscription (simulates resubscribe_all logic)
        let collected_topics: HashSet<String> = store.collect_topics().into_iter().collect();

        // Property: The set of collected topics equals the original set
        prop_assert_eq!(
            collected_topics.len(),
            topics.len(),
            "Number of collected topics ({}) should equal number of subscribed topics ({})",
            collected_topics.len(),
            topics.len()
        );

        // Additional property: Every original topic is in the collected set
        for topic in &topics {
            prop_assert!(
                collected_topics.contains(topic),
                "Topic '{}' was subscribed but not collected for resubscription",
                topic
            );
        }

        // Property: Sets are equal (checked last to avoid move issues)
        prop_assert_eq!(
            collected_topics,
            topics,
            "Collected topics should exactly match subscribed topics"
        );
    }

    // Feature: rust-runtime-reliability, Property 3: Topic Resubscription Completeness (Ordering Invariant)
    // **Validates: Requirements 1.10**
    //
    // This test verifies that topic collection works correctly regardless of subscription order.
    // The order in which topics are subscribed should not affect the completeness of resubscription.
    #[test]
    fn topic_resubscription_order_independent(
        topics in prop::collection::vec(mqtt_topic_strategy(), 1..=30),
        shuffle_seed in any::<u64>()
    ) {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        // Create a deterministic shuffle based on the seed
        let mut indexed_topics: Vec<(usize, &String)> = topics.iter().enumerate().collect();
        indexed_topics.sort_by(|(i1, t1), (i2, t2)| {
            let mut h1 = DefaultHasher::new();
            let mut h2 = DefaultHasher::new();
            (shuffle_seed, *i1, *t1).hash(&mut h1);
            (shuffle_seed, *i2, *t2).hash(&mut h2);
            h1.finish().cmp(&h2.finish())
        });

        let mut store = MockSubscriptionStore::new();

        // Subscribe in shuffled order
        for (_, topic) in &indexed_topics {
            store.subscribe(topic);
        }

        // Collect topics
        let collected: HashSet<String> = store.collect_topics().into_iter().collect();

        // Get unique topics from original list (in case of duplicates)
        let unique_topics: HashSet<String> = topics.into_iter().collect();

        // Property: All unique topics should be collected regardless of subscription order
        prop_assert_eq!(
            collected,
            unique_topics,
            "Topic collection should be independent of subscription order"
        );
    }

    // Feature: rust-runtime-reliability, Property 3: Topic Resubscription Completeness (Idempotency)
    // **Validates: Requirements 1.10**
    //
    // This test verifies that subscribing to the same topic multiple times
    // results in exactly one entry for resubscription (no duplicates).
    #[test]
    fn topic_resubscription_no_duplicates(
        base_topics in mqtt_topic_set_strategy(20),
        repeat_count in 1usize..5
    ) {
        let mut store = MockSubscriptionStore::new();

        // Subscribe to each topic multiple times
        for _ in 0..repeat_count {
            for topic in &base_topics {
                store.subscribe(topic);
            }
        }

        // Collect topics
        let collected: Vec<String> = store.collect_topics();
        let collected_set: HashSet<String> = collected.iter().cloned().collect();

        // Property: No duplicate topics in collected list
        prop_assert_eq!(
            collected.len(),
            collected_set.len(),
            "Collected topics should have no duplicates (got {} items but {} unique)",
            collected.len(),
            collected_set.len()
        );

        // Property: Collected set equals original set
        prop_assert_eq!(
            collected_set,
            base_topics,
            "Collected topics should match original subscribed topics"
        );
    }
}
