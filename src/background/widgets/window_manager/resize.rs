/// Limit a resize before changing either side of a split. CSS rejects negative
/// flex-grow values, so clamping each node after redistribution would lose space.
pub fn resize_delta(window: f32, siblings: &[f32], percentage: f32, relative: bool) -> f32 {
    if siblings.is_empty()
        || !percentage.is_finite()
        || !window.is_finite()
        || window <= 0.0
        || siblings.iter().any(|v| !v.is_finite() || *v <= 0.0)
    {
        return 0.0;
    }

    let sibling_total: f32 = siblings.iter().sum();
    let smallest = siblings.iter().copied().fold(window, f32::min);
    // Reserve 1% of the split for each node, respecting smaller custom weights.
    let minimum = ((window + sibling_total) * 0.01).min(smallest);
    let requested = if relative { window } else { sibling_total } * percentage / 100.0;
    let maximum = siblings
        .iter()
        .map(|v| (v - minimum) * siblings.len() as f32)
        .fold(f32::INFINITY, f32::min);

    requested.clamp(minimum - window, maximum)
}

#[cfg(test)]
mod tests {
    use super::resize_delta;

    #[test]
    fn ordinary_resize_preserves_the_requested_change() {
        assert!((resize_delta(1.0, &[1.0], 25.0, true) - 0.25).abs() < 0.00001);
        assert!((resize_delta(1.0, &[1.0, 2.0], 10.0, false) - 0.3).abs() < 0.00001);
    }

    #[test]
    fn oversized_resize_preserves_positive_weights_and_total_space() {
        for percentage in [-1000.0, -100.0, 100.0, 1000.0] {
            let window = 1.0;
            let siblings = [0.2, 1.8];
            let delta = resize_delta(window, &siblings, percentage, true);
            let resized_window = window + delta;
            let resized_siblings = siblings.map(|v| v - delta / siblings.len() as f32);
            assert!(resized_window > 0.0);
            assert!(resized_siblings.iter().all(|v| *v > 0.0));
            assert!((resized_window + resized_siblings.iter().sum::<f32>() - 3.0).abs() < 0.00001);
        }
    }

    #[test]
    fn repeated_resizing_cannot_collapse_a_tile() {
        let mut window = 1.0;
        let mut sibling = 1.0;
        for _ in 0..100 {
            let delta = resize_delta(window, &[sibling], -50.0, true);
            window += delta;
            sibling -= delta;
        }
        assert!((window - 0.02).abs() < 0.00001);
        assert!((window + sibling - 2.0).abs() < 0.00001);
    }

    #[test]
    fn small_custom_weights_remain_valid() {
        let delta = resize_delta(0.001, &[0.002], 1000.0, true);
        assert!(delta.is_finite());
        assert!(0.002 - delta > 0.0);
    }

    #[test]
    fn invalid_resize_is_ignored() {
        assert_eq!(resize_delta(1.0, &[], 10.0, true), 0.0);
        assert_eq!(resize_delta(1.0, &[1.0], f32::NAN, true), 0.0);
        assert_eq!(resize_delta(1.0, &[-1.0], 10.0, true), 0.0);
    }
}
