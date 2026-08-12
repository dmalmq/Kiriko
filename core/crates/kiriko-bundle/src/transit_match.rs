#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TransitPair {
    pub lower_node_id: u32,
    pub upper_node_id: u32,
    pub horizontal_distance_m: f64,
}

pub(crate) fn minimum_cost_maximum_matching(admissible_pairs: &[TransitPair]) -> Vec<TransitPair> {
    let mut pairs: Vec<TransitPair> = admissible_pairs
        .iter()
        .filter(|pair| pair.horizontal_distance_m.is_finite() && pair.horizontal_distance_m >= 0.0)
        .cloned()
        .collect();

    pairs.sort_by(|left, right| {
        left.lower_node_id
            .cmp(&right.lower_node_id)
            .then_with(|| left.upper_node_id.cmp(&right.upper_node_id))
            .then_with(|| {
                left.horizontal_distance_m
                    .total_cmp(&right.horizontal_distance_m)
            })
    });
    pairs.dedup_by(|left, right| {
        left.lower_node_id == right.lower_node_id && left.upper_node_id == right.upper_node_id
    });

    if pairs.is_empty() {
        return Vec::new();
    }

    let mut lower_ids: Vec<u32> = pairs.iter().map(|pair| pair.lower_node_id).collect();
    lower_ids.sort_unstable();
    lower_ids.dedup();

    let mut upper_ids: Vec<u32> = pairs.iter().map(|pair| pair.upper_node_id).collect();
    upper_ids.sort_unstable();
    upper_ids.dedup();

    let source = 0;
    let lower_start = 1;
    let upper_start = lower_start + lower_ids.len();
    let sink = upper_start + upper_ids.len();
    let mut graph = vec![Vec::new(); sink + 1];

    for (lower_index, _) in lower_ids.iter().enumerate() {
        add_edge(&mut graph, source, lower_start + lower_index, 0.0, None);
    }
    for (upper_index, _) in upper_ids.iter().enumerate() {
        add_edge(&mut graph, upper_start + upper_index, sink, 0.0, None);
    }
    for (pair_index, pair) in pairs.iter().enumerate() {
        let lower_index = lower_ids
            .binary_search(&pair.lower_node_id)
            .expect("pair lower node ID must be present");
        let upper_index = upper_ids
            .binary_search(&pair.upper_node_id)
            .expect("pair upper node ID must be present");
        add_edge(
            &mut graph,
            lower_start + lower_index,
            upper_start + upper_index,
            pair.horizontal_distance_m,
            Some(pair_index),
        );
    }

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

        if predecessor[sink].is_none() {
            break;
        }

        let mut current = sink;
        while current != source {
            let (from, edge_index) =
                predecessor[current].expect("every augmenting path node has a predecessor");
            augment_edge(&mut graph, from, edge_index);
            current = from;
        }
    }

    let mut matches = Vec::new();
    for lower_index in 0..lower_ids.len() {
        let lower_node = lower_start + lower_index;
        for edge in &graph[lower_node] {
            if edge.capacity == 0 {
                if let Some(pair_index) = edge.pair_index {
                    matches.push(pairs[pair_index].clone());
                }
            }
        }
    }
    matches.sort_unstable_by_key(|pair| (pair.lower_node_id, pair.upper_node_id));
    matches
}

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
        let matches =
            minimum_cost_maximum_matching(&[pair(1, 10, 1.0), pair(2, 10, 1.1), pair(2, 11, 2.0)]);
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
