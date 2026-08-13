//! Deterministic one-to-one matching for vertical transit links.
//!
//! Both synthesizers group admissible lower/upper transit candidates by
//! adjacent ordinal pair and exact category string, compute the horizontal
//! centroid distance for each pair, and hand the whole group to
//! [`minimum_cost_maximum_matching`]. This module solves one bipartite group
//! with a successive-shortest-augmenting-paths min-cost flow: the result
//! maximizes the number of matched pairs first and minimizes the total
//! horizontal distance second, with equal-cost choices settled by ascending
//! node IDs so the output never depends on input pair order.
//!
//! Dependency-free by design: this file must compile when the `netgen`
//! feature is disabled, so it never imports `geo`.

/// One admissible lower→upper transit pairing with its horizontal distance.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TransitPair {
    pub lower_node_id: u32,
    pub upper_node_id: u32,
    pub horizontal_distance_m: f64,
}

/// Solve one bipartite transit group: maximum cardinality first, minimum
/// total horizontal distance second, deterministic ID tie-breaking.
///
/// Pairs with non-finite or negative distances are dropped; duplicate
/// `(lower, upper)` IDs keep the shortest distance. The output is sorted by
/// `(lower_node_id, upper_node_id)`.
pub(crate) fn minimum_cost_maximum_matching(
    admissible_pairs: &[TransitPair],
) -> Vec<TransitPair> {
    // 1. Keep finite non-negative distances and sort deterministically by
    // (lower ID, upper ID, distance) so every later choice is input-order
    // invariant.
    let mut pairs: Vec<TransitPair> = admissible_pairs
        .iter()
        .filter(|pair| {
            pair.horizontal_distance_m.is_finite() && pair.horizontal_distance_m >= 0.0
        })
        .cloned()
        .collect();
    pairs.sort_by(|a, b| {
        (a.lower_node_id, a.upper_node_id)
            .cmp(&(b.lower_node_id, b.upper_node_id))
            .then_with(|| a.horizontal_distance_m.total_cmp(&b.horizontal_distance_m))
    });
    // 2. Duplicate (lower, upper) IDs: the first — shortest — distance wins.
    let mut unique: Vec<TransitPair> = Vec::with_capacity(pairs.len());
    for pair in pairs {
        match unique.last() {
            Some(prev)
                if prev.lower_node_id == pair.lower_node_id
                    && prev.upper_node_id == pair.upper_node_id => {}
            _ => unique.push(pair),
        }
    }

    // 3. Sorted unique node IDs define the fixed node order below.
    let mut lower_ids: Vec<u32> = unique.iter().map(|pair| pair.lower_node_id).collect();
    lower_ids.sort_unstable();
    lower_ids.dedup();
    let mut upper_ids: Vec<u32> = unique.iter().map(|pair| pair.upper_node_id).collect();
    upper_ids.sort_unstable();
    upper_ids.dedup();

    // 4. Residual nodes in fixed order: source, lowers, uppers, sink.
    let source = 0;
    let lower_offset = source + 1;
    let upper_offset = lower_offset + lower_ids.len();
    let sink = upper_offset + upper_ids.len();
    let mut graph: Vec<Vec<ResidualEdge>> = vec![Vec::new(); sink + 1];

    // 5. Zero-cost unit edges in ID order, then pair edges in sorted order.
    for i in 0..lower_ids.len() {
        add_edge(&mut graph, source, lower_offset + i, 0.0, None);
    }
    for i in 0..upper_ids.len() {
        add_edge(&mut graph, upper_offset + i, sink, 0.0, None);
    }
    for (pair_index, pair) in unique.iter().enumerate() {
        let from = lower_offset
            + lower_ids
                .binary_search(&pair.lower_node_id)
                .expect("pair lower id must be a collected lower id");
        let to = upper_offset
            + upper_ids
                .binary_search(&pair.upper_node_id)
                .expect("pair upper id must be a collected upper id");
        add_edge(&mut graph, from, to, pair.horizontal_distance_m, Some(pair_index));
    }

    // 6-7. Successive shortest augmenting paths: Bellman-Ford per unit of
    // flow (negative reverse edges rule out plain Dijkstra). Augmenting while
    // a source-to-sink path exists establishes maximum cardinality; shortest
    // paths keep each flow size at minimum cost.
    loop {
        let mut distance = vec![f64::INFINITY; graph.len()];
        let mut predecessor: Vec<Option<(usize, usize)>> = vec![None; graph.len()];
        distance[source] = 0.0;
        for _ in 1..graph.len() {
            let mut changed = false;
            for from in 0..graph.len() {
                if !distance[from].is_finite() {
                    continue;
                }
                for (edge_index, edge) in graph[from].iter().enumerate() {
                    if edge.capacity == 0 {
                        continue;
                    }
                    let candidate = distance[from] + edge.cost;
                    if candidate.total_cmp(&distance[edge.to]).is_lt() {
                        distance[edge.to] = candidate;
                        predecessor[edge.to] = Some((from, edge_index));
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        // No residual source-to-sink path: the flow is maximum.
        if predecessor[sink].is_none() {
            break;
        }
        let mut node = sink;
        while let Some((from, edge_index)) = predecessor[node] {
            augment_edge(&mut graph, from, edge_index);
            node = from;
        }
    }

    // 8. A pair edge at zero residual capacity carried the flow: selected.
    let mut selected: Vec<TransitPair> = Vec::new();
    for from in lower_offset..upper_offset {
        for edge in &graph[from] {
            if let Some(pair_index) = edge.pair_index {
                if edge.capacity == 0 {
                    selected.push(unique[pair_index].clone());
                }
            }
        }
    }
    selected.sort_by(|a, b| {
        (a.lower_node_id, a.upper_node_id).cmp(&(b.lower_node_id, b.upper_node_id))
    });
    selected
}

/// Residual-graph edge: forward pair edges carry their cost and the source
/// `unique` index; structural edges and reverses carry none.
#[derive(Clone, Copy)]
struct ResidualEdge {
    to: usize,
    reverse: usize,
    capacity: u8,
    cost: f64,
    pair_index: Option<usize>,
}

fn add_edge(
    graph: &mut [Vec<ResidualEdge>],
    from: usize,
    to: usize,
    cost: f64,
    pair_index: Option<usize>,
) {
    let forward_reverse = graph[to].len();
    let backward_reverse = graph[from].len();
    graph[from].push(ResidualEdge {
        to,
        reverse: forward_reverse,
        capacity: 1,
        cost,
        pair_index,
    });
    graph[to].push(ResidualEdge {
        to: from,
        reverse: backward_reverse,
        capacity: 0,
        cost: -cost,
        pair_index: None,
    });
}

fn augment_edge(graph: &mut [Vec<ResidualEdge>], from: usize, edge_index: usize) {
    let to = graph[from][edge_index].to;
    let reverse = graph[from][edge_index].reverse;
    graph[from][edge_index].capacity -= 1;
    graph[to][reverse].capacity += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(lower: u32, upper: u32, distance: f64) -> TransitPair {
        TransitPair {
            lower_node_id: lower,
            upper_node_id: upper,
            horizontal_distance_m: distance,
        }
    }

    fn ids(matches: &[TransitPair]) -> Vec<(u32, u32)> {
        matches
            .iter()
            .map(|pair| (pair.lower_node_id, pair.upper_node_id))
            .collect()
    }

    #[test]
    fn matching_avoids_nearest_neighbor_fan_in() {
        let matches = minimum_cost_maximum_matching(&[
            pair(1, 10, 1.0),
            pair(2, 10, 1.1),
            pair(2, 11, 2.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 10), (2, 11)]);
    }

    #[test]
    fn matching_minimizes_total_distance_after_cardinality() {
        let matches = minimum_cost_maximum_matching(&[
            pair(1, 10, 1.0),
            pair(1, 11, 2.0),
            pair(2, 10, 1.1),
            pair(2, 11, 100.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 11), (2, 10)]);
    }

    #[test]
    fn matching_breaks_equal_costs_by_node_ids() {
        let matches = minimum_cost_maximum_matching(&[
            pair(2, 11, 1.0),
            pair(1, 11, 1.0),
            pair(2, 10, 1.0),
            pair(1, 10, 1.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 10), (2, 11)]);
    }

    #[test]
    fn matching_is_input_order_invariant() {
        let forward = vec![
            pair(1, 10, 1.0),
            pair(1, 11, 2.0),
            pair(2, 10, 1.1),
            pair(2, 11, 100.0),
        ];
        let mut reverse = forward.clone();
        reverse.reverse();
        assert_eq!(
            minimum_cost_maximum_matching(&forward),
            minimum_cost_maximum_matching(&reverse),
        );
    }

    #[test]
    fn empty_admissible_set_has_no_matches() {
        assert!(minimum_cost_maximum_matching(&[]).is_empty());
    }
}
