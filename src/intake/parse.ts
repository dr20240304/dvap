import zlib from 'node:zlib';
import { dollars } from '../common/money';

export interface ParsedInvoice {
  id: string;
  vendor: string;
  /** micro-USDC, as a decimal string */
  amount: string;
  dueDate: string;
  memo: string;
}

/** WinAnsi bytes that differ from Latin-1 and matter for invoices (dashes, quotes). */
const WIN_ANSI: Record<number, string> = { 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };
const decode = (b: number[]) => b.map((c) => WIN_ANSI[c] ?? String.fromCharCode(c)).join('');

/** Bytes of a PDF literal string starting at s[i] === '('; returns the bytes and the index after the closing ')'. */
function literal(s: string, i: number): [number[], number] {
  const out: number[] = [];
  let depth = 0;
  for (i++; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[++i]!;
      if (/[0-7]/.test(n)) {
        let o = n;
        while (o.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) o += s[++i];
        out.push(parseInt(o, 8) & 0xff);
      } else if (n === '\r' || n === '\n') {
        if (n === '\r' && s[i + 1] === '\n') i++;
      } else out.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n as 'n'] ?? n.charCodeAt(0));
    } else if (c === '(') { depth++; out.push(40); }
    else if (c === ')') { if (depth === 0) return [out, i + 1]; depth--; out.push(41); }
    else out.push(c.charCodeAt(0) & 0xff);
  }
  return [out, i];
}

/** Text drawn by one content stream, one line per vertical move (BT/ET, Tj, TJ, ', ", Td, TD, T*, Tm). Colour and size are ignored. */
function streamText(s: string): string {
  let text = '';
  let newline = false;
  let lastY: number | undefined;
  let operands: (string | number)[] = [];
  let arr: string[] | undefined;
  const show = (part: string) => {
    if (newline && text && !text.endsWith('\n')) text += '\n';
    newline = false;
    text += part;
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === '(') {
      const [b, next] = literal(s, i);
      (arr ?? operands).push(decode(b));
      i = next;
    } else if (c === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end).replace(/\s/g, '');
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      (arr ?? operands).push(decode(bytes));
      i = end + 1;
    } else if (c === '[') { arr = []; i++; }
    else if (c === ']') { operands.push((arr ?? []).join('')); arr = undefined; i++; }
    else if (c === '%') { i = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i); }
    else if (/\s/.test(c)) i++;
    else {
      let j = i;
      while (j < s.length && !/[\s()<>[\]/%]/.test(s[j]!)) j++;
      if (c === '/') { j = i + 1; while (j < s.length && !/[\s()<>[\]/%]/.test(s[j]!)) j++; operands.push(s.slice(i, j)); i = j; continue; }
      const tok = s.slice(i, j) || s[i]!;
      i = Math.max(j, i + 1);
      const num = Number(tok);
      if (tok !== '' && !Number.isNaN(num)) { operands.push(num); continue; }
      const last = operands[operands.length - 1];
      if (tok === 'Tj' || tok === 'TJ') show(String(last ?? ''));
      else if (tok === "'" || tok === '"') { newline = true; show(String(last ?? '')); }
      else if (tok === 'T*') newline = true;
      else if ((tok === 'Td' || tok === 'TD') && operands.length >= 2 && Number(operands[operands.length - 1]) !== 0) newline = true;
      else if (tok === 'Tm' && operands.length >= 6) {
        const y = Number(operands[operands.length - 1]);
        if (lastY !== undefined && y !== lastY) newline = true;
        lastY = y;
      } else if (tok === 'BT') newline = true;
      operands = [];
    }
  }
  return text;
}

/** Every content stream in the file, inflated when FlateDecode, as latin1 text. */
function streams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const dictStart = raw.lastIndexOf('obj', m.index!);
    const dict = raw.slice(dictStart, m.index!);
    let body = pdf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { body = zlib.inflateSync(body); } catch { continue; }
    } else if (/\/Filter/.test(dict)) continue; // an encoding this reader does not know
    const text = body.toString('latin1');
    if (/\bBT\b/.test(text)) out.push(text);
  }
  return out;
}

/**
 * The AP mailbox's PDF reader: pull every piece of drawn text out of the PDF (whatever its colour or size), then lift the labelled
 * fields. Everything after the "Memo:" label becomes the invoice memo that the agent later reads. Reads simple generated invoices
 * (Type1/TrueType text with WinAnsi encoding, plain or FlateDecode streams); a production reader would also handle CID fonts.
 */
export async function parseInvoicePdf(pdf: Uint8Array): Promise<ParsedInvoice> {
  const buf = Buffer.from(pdf);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const text = streams(buf).map(streamText).join('\n');
  const field = (label: string) => new RegExp(`^${label}:[ \\t]*(.+)$`, 'im').exec(text)?.[1]?.trim();
  const id = field('Invoice');
  const vendor = field('Vendor');
  const amount = field('Amount')?.replace(/[$,\s]/g, '');
  const dueDate = field('Due') ?? '';
  const memoAt = /^Memo:[ \t]*/im.exec(text);
  if (!id || !/^INV-\d+$/.test(id)) throw new Error('no invoice number');
  if (!vendor) throw new Error('no vendor');
  if (!amount || !/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('no amount');
  if (!memoAt) throw new Error('no memo');
  return { id, vendor, amount: String(dollars(Number(amount))), dueDate, memo: text.slice(memoAt.index + memoAt[0].length).trim() };
}
