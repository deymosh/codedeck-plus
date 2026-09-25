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

#[cfg(test)]
mod tests {
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
