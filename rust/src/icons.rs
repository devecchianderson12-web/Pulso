// Draws Pulso's icons as vector shapes (signed distance fields) at each exact pixel size, with
// analytic anti-aliasing, so edges stay smooth at 16 px and at 256 px alike. Port of src/icons.js.
use serde_json::Value;

type Pt = (f64, f64);

fn seg_dist(px: f64, py: f64, a: Pt, b: Pt) -> f64 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let t = (((px - a.0) * vx + (py - a.1) * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
    (px - (a.0 + vx * t)).hypot(py - (a.1 + vy * t))
}

fn stroke(points: &[Pt], width: f64, x: f64, y: f64) -> f64 {
    let mut d = f64::INFINITY;
    for w in points.windows(2) {
        d = d.min(seg_dist(x, y, w[0], w[1]));
    }
    d - width / 2.0
}

const C: Pt = (0.535, 0.465);
const RING: f64 = 0.355;
// The ring opens between these angles, where the speech tail joins it.
const GAP_FROM: f64 = 110.0;
const GAP_TO: f64 = 142.0;
const PULSE: [Pt; 7] = [(0.3, 0.48), (0.405, 0.48), (0.462, 0.325), (0.545, 0.635), (0.602, 0.44), (0.642, 0.505), (0.77, 0.505)];

fn ring_point(deg: f64) -> Pt {
    let r = deg.to_radians();
    (C.0 + RING * r.cos(), C.1 + RING * r.sin())
}

fn mark_dist(weight: f64, x: f64, y: f64) -> f64 {
    let w = 0.088 * weight;
    let tail = [ring_point(GAP_TO), (0.105, 0.925), ring_point(GAP_FROM)];
    let ang = (y - C.1).atan2(x - C.0).to_degrees();
    let ring = if ang > GAP_FROM && ang < GAP_TO {
        f64::INFINITY
    } else {
        ((x - C.0).hypot(y - C.1) - RING).abs() - w / 2.0
    };
    ring.min(stroke(&tail, w, x, y)).min(stroke(&PULSE, 0.072 * weight, x, y))
}

/// The mark's colors. The angle follows CSS: 0 points up, 90 to the right.
#[derive(Clone)]
pub struct Style {
    from: [f64; 3],
    to: [f64; 3],
    angle: f64,
    gradient: bool,
}

pub const DEFAULT_FROM: &str = "#2ceb9a";
pub const DEFAULT_TO: &str = "#10b673";

pub fn hex(s: &str) -> Option<[f64; 3]> {
    if s.len() != 7 || !s.starts_with('#') {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok().map(f64::from);
    Some([p(1)?, p(3)?, p(5)?])
}

impl Style {
    pub fn default_style() -> Self {
        Style { from: hex(DEFAULT_FROM).unwrap(), to: hex(DEFAULT_TO).unwrap(), angle: 135.0, gradient: true }
    }
    /// From the saved `icon` setting ({kind: "color", from, to, angle, gradient}).
    pub fn from_setting(v: &Value) -> Self {
        if v.get("kind").and_then(Value::as_str) != Some("color") {
            return Self::default_style();
        }
        let d = Self::default_style();
        Style {
            from: v.get("from").and_then(Value::as_str).and_then(hex).unwrap_or(d.from),
            to: v.get("to").and_then(Value::as_str).and_then(hex).unwrap_or(d.to),
            angle: v.get("angle").and_then(Value::as_f64).unwrap_or(135.0),
            gradient: v.get("gradient").and_then(Value::as_bool).unwrap_or(true),
        }
    }
    fn color(&self, x: f64, y: f64) -> [f64; 3] {
        if !self.gradient {
            return self.from;
        }
        let rad = self.angle.to_radians();
        let (s, c) = (rad.sin(), rad.cos());
        let t = (((x - 0.5) * s - (y - 0.5) * c) / (s.abs() + c.abs()) + 0.5).clamp(0.0, 1.0);
        [0, 1, 2].map(|i| self.from[i] + (self.to[i] - self.from[i]) * t)
    }
}

// Digits as strokes in a 0.6 x 1 box.
fn digit(ch: char) -> Vec<Vec<Pt>> {
    match ch {
        '0' => vec![vec![(0.0, 0.0), (0.6, 0.0), (0.6, 1.0), (0.0, 1.0), (0.0, 0.0)]],
        '1' => vec![vec![(0.12, 0.2), (0.34, 0.0), (0.34, 1.0)]],
        '2' => vec![vec![(0.0, 0.0), (0.6, 0.0), (0.6, 0.5), (0.0, 0.5), (0.0, 1.0), (0.6, 1.0)]],
        '3' => vec![vec![(0.0, 0.0), (0.6, 0.0), (0.6, 1.0), (0.0, 1.0)], vec![(0.06, 0.5), (0.6, 0.5)]],
        '4' => vec![vec![(0.0, 0.0), (0.0, 0.55), (0.6, 0.55)], vec![(0.6, 0.0), (0.6, 1.0)]],
        '5' => vec![vec![(0.6, 0.0), (0.0, 0.0), (0.0, 0.5), (0.6, 0.5), (0.6, 1.0), (0.0, 1.0)]],
        '6' => vec![vec![(0.6, 0.0), (0.0, 0.0), (0.0, 1.0), (0.6, 1.0), (0.6, 0.5), (0.0, 0.5)]],
        '7' => vec![vec![(0.0, 0.0), (0.6, 0.0), (0.25, 1.0)]],
        '8' => vec![vec![(0.0, 0.0), (0.6, 0.0), (0.6, 1.0), (0.0, 1.0), (0.0, 0.0)], vec![(0.0, 0.5), (0.6, 0.5)]],
        '9' => vec![vec![(0.6, 0.5), (0.0, 0.5), (0.0, 0.0), (0.6, 0.0), (0.6, 1.0), (0.0, 1.0)]],
        _ => vec![vec![(0.3, 0.12), (0.3, 0.88)], vec![(-0.08, 0.5), (0.68, 0.5)]], // '+'
    }
}

// Text centered at (cx, cy) with height h, as strokes in image space.
fn text_strokes(text: &str, cx: f64, cy: f64, h: f64) -> Vec<(Vec<Pt>, f64)> {
    let n = text.chars().count() as f64;
    let gap = 0.35;
    let width = (n * 0.6 + (n - 1.0) * gap) * h;
    let mut out = Vec::new();
    for (i, ch) in text.chars().enumerate() {
        let ox = cx - width / 2.0 + i as f64 * (0.6 + gap) * h;
        for line in digit(ch) {
            out.push((line.iter().map(|&(px, py)| (ox + px * h, cy - h / 2.0 + py * h)).collect(), h * 0.2));
        }
    }
    out
}

enum Shape {
    Mark(f64),
    Circle(f64, f64, f64),
    Text(Vec<(Vec<Pt>, f64)>),
}

impl Shape {
    fn dist(&self, x: f64, y: f64) -> f64 {
        match self {
            Shape::Mark(w) => mark_dist(*w, x, y),
            Shape::Circle(cx, cy, r) => (x - cx).hypot(y - cy) - r,
            Shape::Text(strokes) => strokes.iter().map(|(p, w)| stroke(p, *w, x, y)).fold(f64::INFINITY, f64::min),
        }
    }
}

enum Paint<'a> {
    Solid([f64; 3]),
    Mark(&'a Style),
    Erase,
}

// Layers drawn bottom to top over an optional RGBA base image.
fn render(size: u32, layers: &[(Shape, Paint)], base: Option<Vec<u8>>) -> Vec<u8> {
    let s = size as usize;
    let mut px = base.unwrap_or_else(|| vec![0; s * s * 4]);
    let aa = 1.0 / size as f64;
    for j in 0..s {
        for i in 0..s {
            let (x, y) = ((i as f64 + 0.5) / size as f64, (j as f64 + 0.5) / size as f64);
            let k = (j * s + i) * 4;
            let mut a = px[k + 3] as f64 / 255.0;
            let (mut r, mut g, mut b) = (px[k] as f64 * a, px[k + 1] as f64 * a, px[k + 2] as f64 * a);
            for (shape, paint) in layers {
                let cov = (0.5 - shape.dist(x, y) / aa).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                let c = match paint {
                    Paint::Erase => {
                        r *= 1.0 - cov;
                        g *= 1.0 - cov;
                        b *= 1.0 - cov;
                        a *= 1.0 - cov;
                        continue;
                    }
                    Paint::Solid(c) => *c,
                    Paint::Mark(style) => style.color(x, y),
                };
                r = c[0] * cov + r * (1.0 - cov);
                g = c[1] * cov + g * (1.0 - cov);
                b = c[2] * cov + b * (1.0 - cov);
                a = cov + a * (1.0 - cov);
            }
            if a > 0.0 {
                px[k] = (r / a).round() as u8;
                px[k + 1] = (g / a).round() as u8;
                px[k + 2] = (b / a).round() as u8;
            }
            px[k + 3] = (a * 255.0).round() as u8;
        }
    }
    px
}

// Thicker strokes at small sizes keep the mark legible.
fn weight_for(size: u32) -> f64 {
    if size <= 20 {
        1.35
    } else if size <= 32 {
        1.18
    } else {
        1.0
    }
}

/// An RGBA image (the user's .ico) scaled to `size` with a box filter.
pub fn resample(rgba: &[u8], w: u32, h: u32, size: u32) -> Vec<u8> {
    let mut out = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let (x0, x1) = (x * w / size, ((x + 1) * w / size).max(x * w / size + 1).min(w));
            let (y0, y1) = (y * h / size, ((y + 1) * h / size).max(y * h / size + 1).min(h));
            let mut acc = [0f64; 4];
            let mut n = 0f64;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let k = ((sy * w + sx) * 4) as usize;
                    let al = rgba[k + 3] as f64;
                    acc[0] += rgba[k] as f64 * al;
                    acc[1] += rgba[k + 1] as f64 * al;
                    acc[2] += rgba[k + 2] as f64 * al;
                    acc[3] += al;
                    n += 1.0;
                }
            }
            let k = ((y * size + x) * 4) as usize;
            if acc[3] > 0.0 {
                for c in 0..3 {
                    out[k + c] = (acc[c] / acc[3]).round() as u8;
                }
            }
            out[k + 3] = (acc[3] / n.max(1.0)).round() as u8;
        }
    }
    out
}

/// What the icon looks like: the drawn mark in some colors, or the user's own image.
pub enum Look {
    Mark(Style),
    Custom { rgba: Vec<u8>, w: u32, h: u32 },
}

impl Look {
    pub fn mark_rgba(&self, size: u32) -> Vec<u8> {
        match self {
            Look::Mark(style) => render(size, &[(Shape::Mark(weight_for(size)), Paint::Mark(style))], None),
            Look::Custom { rgba, w, h } => resample(rgba, *w, *h, size),
        }
    }

    /// Mark with a red counter in the lower-right corner, cut out from the mark behind it.
    pub fn tray_rgba(&self, size: u32, count: u32) -> Vec<u8> {
        if count == 0 {
            return self.mark_rgba(size);
        }
        let label = if count > 9 { "+".to_string() } else { count.to_string() };
        let mut layers = Vec::new();
        let base = match self {
            Look::Mark(style) => {
                layers.push((Shape::Mark(weight_for(size)), Paint::Mark(style)));
                None
            }
            Look::Custom { .. } => Some(self.mark_rgba(size)),
        };
        layers.push((Shape::Circle(0.72, 0.72, 0.335), Paint::Erase));
        layers.push((Shape::Circle(0.72, 0.72, 0.28), Paint::Solid(RED)));
        layers.push((Shape::Text(text_strokes(&label, 0.72, 0.72, 0.3)), Paint::Solid(WHITE)));
        render(size, &layers, base)
    }

    /// Windows icon (.ico) holding a PNG per size, so Windows never has to rescale.
    pub fn ico(&self) -> Vec<u8> {
        let sizes = [16u32, 20, 24, 32, 40, 48, 64, 96, 128, 256];
        let images: Vec<Vec<u8>> = sizes.iter().map(|&s| png(s, &self.mark_rgba(s))).collect();
        let mut out = Vec::new();
        out.extend_from_slice(&[0, 0, 1, 0]);
        out.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
        let mut offset = 6 + 16 * sizes.len() as u32;
        for (i, &s) in sizes.iter().enumerate() {
            let d = if s >= 256 { 0 } else { s as u8 };
            out.extend_from_slice(&[d, d, 0, 0]);
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&32u16.to_le_bytes());
            out.extend_from_slice(&(images[i].len() as u32).to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            offset += images[i].len() as u32;
        }
        for img in images {
            out.extend_from_slice(&img);
        }
        out
    }
}

const RED: [f64; 3] = [229.0, 57.0, 53.0];
const WHITE: [f64; 3] = [255.0, 255.0, 255.0];

pub fn badge_label(count: u32) -> String {
    if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    }
}

/// Taskbar overlay: red circle with the count.
pub fn overlay_rgba(size: u32, count: u32) -> Vec<u8> {
    let label = badge_label(count);
    let h = match label.len() {
        n if n > 2 => 0.26,
        2 => 0.4,
        _ => 0.5,
    };
    render(
        size,
        &[
            (Shape::Circle(0.5, 0.5, 0.48), Paint::Solid(RED)),
            (Shape::Text(text_strokes(&label, 0.5, 0.5, h)), Paint::Solid(WHITE)),
        ],
        None,
    )
}

pub fn png(size: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, size, size);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().expect("png header");
        w.write_image_data(rgba).expect("png data");
    }
    out
}
