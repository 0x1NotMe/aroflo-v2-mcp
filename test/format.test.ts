import { describe, expect, it } from 'vitest';
import { cell, clean, cut, plainText, record, render, shortDate, table } from '../src/format.js';

describe('clean', () => {
  it('drops _links, nulls and empty values recursively', () => {
    expect(clean({ id: 'A', _links: { api: '/x' }, a: null, b: '', c: [], d: {}, e: { f: null, g: 1 }, h: '  ' })).toEqual({ id: 'A', e: { g: 1 } });
  });
});

describe('plainText', () => {
  it('turns AroFlo HTML notes into one line', () => {
    expect(plainText('<p>Gate code&nbsp;1234</p><br/>Call &amp; text first<br>')).toBe('Gate code 1234 / Call & text first');
  });
  it('leaves plain text alone apart from whitespace', () => {
    expect(plainText('  two   spaces\n')).toBe('two spaces');
  });
  it('leaves out-of-range numeric entities as they are', () => {
    expect(plainText('a &#1114112; b &#xD800; c')).toBe('a &#1114112; b &#xD800; c');
  });
  it('turns typographic entities into ASCII', () => {
    expect(plainText('I&rsquo;m &ldquo;here&rdquo; &ndash; ok&hellip;')).toBe('I\'m "here" - ok...');
  });
  it('decodes numeric entities', () => {
    expect(plainText('Tom&#39;s &#x2013; ok')).toBe("Tom's – ok");
  });
});

describe('shortDate', () => {
  it.each([
    ['2026-11-04T00:00:00.000Z', '2026-11-04'],
    ['2026-11-04T09:30:00Z', '2026-11-04 09:30Z'],
    ['2026-11-04T09:30:15+11:00', '2026-11-04 09:30:15+11:00'],
    ['2026-11-04T00:00:00+11:00', '2026-11-04 00:00+11:00'],
    ['not a date', 'not a date']
  ])('%s -> %s', (input, out) => expect(shortDate(input)).toBe(out));
});

describe('cut', () => {
  it('marks how much was left out when asked', () => {
    expect(cut('abcdef', 3, true)).toBe('abc… [+3 chars]');
    expect(cut('abcdef', 3)).toBe('ab…');
    expect(cut('abc', 3)).toBe('abc');
  });
});

describe('cell', () => {
  it('collapses nested objects to their label, then id', () => {
    expect(cell({ id: 'C1', name: 'Smith, Jo' })).toBe('Smith, Jo');
    expect(cell({ id: 'C1' })).toBe('C1');
    expect(cell({ givenName: 'Jo', familyName: 'Smith' })).toBe('Jo Smith');
  });
  it('summarises arrays', () => {
    expect(cell([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }])).toBe('a, b, c +1');
    expect(cell([1, 2])).toBe('1, 2');
  });
  it('never emits tabs or newlines; line breaks become " / "', () => {
    expect(cell('a\tb\nc')).toBe('a b / c');
  });
});

describe('table', () => {
  const rows = [
    { name: 'Job A', id: 'T1', jobNumber: 1001, status: 'In Progress', client: { id: 'C1', name: 'Smith' }, empty: null, _links: { api: '/t/1' } },
    { name: 'Job B', id: 'T2', jobNumber: 1002, status: 'Completed', client: { id: 'C2', name: 'Lee' }, empty: '' }
  ];
  it('writes the header once and puts id, jobNumber, name first', () => {
    expect(table(rows)).toBe('id\tjobNumber\tname\tstatus\tclient\nT1\t1001\tJob A\tIn Progress\tSmith\nT2\t1002\tJob B\tCompleted\tLee');
  });
  it('says columns that are the same on every row once, above the table', () => {
    const rows = [1, 2, 3].map((i) => ({ id: `L${i}`, item: `Item ${i}`, type: 'MATERIAL', uom: 'ea' }));
    expect(table(rows)).toBe('same for all rows: type=MATERIAL, uom=ea\nid\titem\nL1\tItem 1\nL2\tItem 2\nL3\tItem 3');
    expect(table(rows.slice(0, 2)).split('\n')[0]).toBe('id\titem\ttype\tuom');
  });
  it('follows a requested column order and drops columns with no values', () => {
    expect(table(rows, { columns: ['status', 'empty', 'id'] }).split('\n')[0]).toBe('status\tid\tjobNumber\tname\tclient');
  });
});

describe('record', () => {
  it('renders refs as label [id], flattens other objects, tables arrays of objects', () => {
    const out = record({
      id: 'Q1',
      name: 'Front garden',
      client: { id: 'C1', name: 'Smith', _links: {} },
      counts: { total: 1200.5, tax: 109.14 },
      takeoffs: [
        { id: 'K1', name: 'HARDSCAPES' },
        { id: 'K2', name: 'SOFTSCAPES' }
      ],
      note: null
    });
    expect(out).toBe(['id: Q1', 'name: Front garden', 'client: Smith [C1]', 'counts: total=1200.5, tax=109.14', 'takeoffs (2):', 'id\tname\nK1\tHARDSCAPES\nK2\tSOFTSCAPES'].join('\n'));
  });
  it('collapses a big nested object such as a user to name and id, and drops avatar URLs', () => {
    const user = { id: 'U1', givenName: 'Oli', familyName: 'S', email: 'o@x', phone: '1', mobile: '2', position: 'MD', isArchived: false, avatar: 'https://ui-avatars.example/x' };
    expect(record({ estimatedByUser: user })).toBe('estimatedByUser: Oli S [U1]');
  });
  it('puts a small object of plain values on one line', () => {
    expect(record({ acceptanceStatus: { status: 'ACCEPTED', actionedByType: 'MANUAL', actionedByUser: { givenName: 'Jan', familyName: 'W' }, expired: false } })).toBe(
      'acceptanceStatus: status=ACCEPTED, actionedByType=MANUAL, actionedByUser=Jan W, expired=false'
    );
  });
  it('keeps the extra fields of a small reference and cuts long labels', () => {
    expect(record({ taxCode: { id: 'X1', code: 'GST', rate: 10 } })).toBe('taxCode: GST [X1] rate=10');
    expect(record({ client: { id: 'C1', name: 'n'.repeat(30) } }, { maxText: 5 })).toBe('client: nnnnn… [+25 chars] [C1]');
  });
  it('keeps real precision and drops float noise', () => {
    expect(record({ a: 0.00001, b: 0.1 + 0.2, c: 1234.5678 })).toBe('a: 0.00001\nb: 0.3\nc: 1234.5678');
  });
  it('cuts long text with a marker', () => {
    expect(record({ description: 'x'.repeat(50) }, { maxText: 10 })).toBe(`description: ${'x'.repeat(10)}… [+40 chars]`);
  });
});

describe('render', () => {
  it('tables an items envelope and records an object', () => {
    expect(render({ count: 1, page: {}, items: [{ id: 'A' }] })).toBe('id\nA');
    expect(render({ id: 'A', name: 'x' })).toBe('id: A\nname: x');
  });
});
