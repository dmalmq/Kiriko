/// Quantize positions to `u16` per axis inside the batch's own bounds.
/// Returns the quantized vertices plus the origin and scale needed to restore
/// them: `restored = origin + q * scale`.
pub fn quantize_positions(positions: &[[f32; 3]]) -> (Vec<[u16; 3]>, [f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            min[axis] = min[axis].min(position[axis]);
            max[axis] = max[axis].max(position[axis]);
        }
    }
    if positions.is_empty() {
        return (Vec::new(), [0.0; 3], [1.0; 3]);
    }

    let mut scale = [1.0_f32; 3];
    for axis in 0..3 {
        let extent = max[axis] - min[axis];
        scale[axis] = if extent > 0.0 { extent / 65_535.0 } else { 1.0 };
    }

    let quantized = positions
        .iter()
        .map(|position| {
            let mut out = [0_u16; 3];
            for axis in 0..3 {
                let normalized = (position[axis] - min[axis]) / scale[axis];
                out[axis] = normalized.round().clamp(0.0, 65_535.0) as u16;
            }
            out
        })
        .collect();

    (quantized, min, scale)
}

/// Octahedral normal encoding to two signed 16-bit channels.
pub fn encode_normal_oct(normal: [f32; 3]) -> [i16; 2] {
    let length = (normal[0].abs() + normal[1].abs() + normal[2].abs()).max(f32::EPSILON);
    let mut x = normal[0] / length;
    let mut y = normal[1] / length;
    if normal[2] < 0.0 {
        let previous_x = x;
        x = (1.0 - y.abs()) * if previous_x >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - previous_x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 };
    }
    [
        (x.clamp(-1.0, 1.0) * 32_767.0).round() as i16,
        (y.clamp(-1.0, 1.0) * 32_767.0).round() as i16,
    ]
}

pub fn decode_normal_oct(encoded: [i16; 2]) -> [f32; 3] {
    let x = f32::from(encoded[0]) / 32_767.0;
    let y = f32::from(encoded[1]) / 32_767.0;
    let z = 1.0 - x.abs() - y.abs();
    let (x, y) = if z < 0.0 {
        (
            (1.0 - y.abs()) * if x >= 0.0 { 1.0 } else { -1.0 },
            (1.0 - x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 },
        )
    } else {
        (x, y)
    };
    let length = (x * x + y * y + z * z).sqrt().max(f32::EPSILON);
    [x / length, y / length, z / length]
}
