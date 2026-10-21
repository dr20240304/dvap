import zlib from 'node:zlib';

/**
 * Minimal PDF writer for the Chapter 1 demo: one page, built-in Helvetica, no dependencies.
 * `visible` lines are what a human sees; `hidden` lines are drawn in white at 1pt in the bottom margin, so the page looks
 * blank there but a text extractor (the intake parser) reads them like any other text.
 */
// WinAnsi: the em dash is byte 0x97 (octal 227); anything else outside ASCII becomes '?'.
const esc = (s: string) => s.replace(/[\\()]/g, '\\$&').replace(/\u2014/g, '\\227').replace(/[^\x20-\x7e\\]/g, '?');

export function buildInvoicePdf(opts: { visible: string[]; hidden?: string[]; compress?: boolean }): Buffer {
  const ops: string[] = ['BT', '0 0 0 rg', '/F1 14 Tf', '16 TL', '56 760 Td'];
  for (const line of opts.visible) ops.push(`(${esc(line)}) Tj`, 'T*');
  ops.push('ET');
  if (opts.hidden?.length) {
    ops.push('BT', '1 1 1 rg', '/F1 1 Tf', '2 TL', '56 40 Td');
    for (const line of opts.hidden) ops.push(`(${esc(line)}) Tj`, 'T*');
    ops.push('ET');
  }
  const raw = Buffer.from(ops.join('\n'), 'latin1');
  const body = opts.compress ? zlib.deflateSync(raw) : raw;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length}${opts.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n${body.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
