/**
 * Terminal QR rendering (CDB-036: "terminal QR, unicode half-blocks").
 * `qrcode`'s terminal renderer with `small: true` emits ▄/▀/█ half-block
 * characters — two QR rows per text line, so the code fits a normal terminal.
 */
import QRCode from 'qrcode';

export async function renderTerminalQr(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'M',
  });
}
