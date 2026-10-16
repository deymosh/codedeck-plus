//! The pairing QR, drawn in the terminal with half-block characters (two QR
//! rows per text line). Terminals are usually light text on a dark
//! background, so the blocks draw the LIGHT modules and the quiet zone, and
//! the terminal's background shows through as the dark ones — the same
//! convention as `qrencode -t UTF8`.

use qrcode::{Color, EcLevel, QrCode};

const QUIET: isize = 2;

pub fn render(data: &str) -> String {
    let Ok(code) = QrCode::with_error_correction_level(data, EcLevel::L) else {
        return "(the pairing URL is too long for a QR code — use the URL below)".into();
    };
    let width = code.width() as isize;
    let colors = code.to_colors();
    let light = |x: isize, y: isize| {
        !(x >= 0 && y >= 0 && x < width && y < width && colors[(y * width + x) as usize] == Color::Dark)
    };
    let mut out = String::new();
    let mut y = -QUIET;
    while y < width + QUIET {
        for x in -QUIET..width + QUIET {
            out.push(match (light(x, y), light(x, y + 1)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        out.push('\n');
        y += 2;
    }
    out
}

/// The same code as an SVG for the web page: one path of unit squares on a
/// white field with a four-module quiet zone, which phone cameras need to
/// find the code. `None` when `data` does not fit in a QR code.
pub fn svg(data: &str) -> Option<String> {
    const SVG_QUIET: usize = 4;
    let code = QrCode::with_error_correction_level(data, EcLevel::M).ok()?;
    let width = code.width();
    let size = width + 2 * SVG_QUIET;
    let mut path = String::new();
    for (i, color) in code.to_colors().iter().enumerate() {
        if *color == Color::Dark {
            let (x, y) = (i % width + SVG_QUIET, i / width + SVG_QUIET);
            path.push_str(&format!("M{x} {y}h1v1h-1z"));
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\">\
         <rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/><path fill=\"#000\" d=\"{path}\"/></svg>"
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn draws_an_svg_with_its_quiet_zone() {
        let svg = super::svg("codedeck://web-sign-in?code=ABCD").unwrap();
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
        assert!(svg.contains("fill=\"#fff\"") && svg.contains("M4 4h1v1h-1z"), "the finder pattern starts past the quiet zone");
    }

    #[test]
    fn renders_a_square_block_with_a_light_border() {
        let qr = super::render("codedeck://pair?npub=npub1xyz&token=abc");
        let lines: Vec<&str> = qr.lines().collect();
        let width = lines[0].chars().count();
        assert!(width > 20 && lines.iter().all(|l| l.chars().count() == width));
        assert!((lines.len() as isize - width as isize / 2).abs() <= 1);
        assert!(lines[0].chars().all(|c| c == '█'), "the quiet zone is light");
    }
}
