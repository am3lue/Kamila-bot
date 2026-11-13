// Minimal vCard (.vcf) parser for contact import: name + phone numbers.

export function parseVCard(vcf) {
  const seen = new Set();
  const contacts = [];
  for (const card of String(vcf).split('BEGIN:VCARD')) {
    if (!card.trim()) continue;
    let name = '';
    let quotedPrintable = false;
    const phones = [];
    for (const line of card.split(/\r?\n/)) {
      const upper = line.toUpperCase();
      if (upper.includes('ENCODING=QUOTED-PRINTABLE')) quotedPrintable = true;
      if (upper.startsWith('PHOTO')) continue;
      if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
        const raw = line.slice(line.indexOf(':') + 1).trim();
        name = quotedPrintable && upper.includes('QUOTED-PRINTABLE')
          ? raw.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          : raw;
      }
      if (upper.startsWith('TEL') && !upper.startsWith('TEL;TYPE=')) {
        const phone = line.slice(line.indexOf(':') + 1).replace(/[^0-9+]/g, '').replace(/^\+/, '');
        if (phone.length >= 7 && !phones.includes(phone)) phones.push(phone);
      }
    }
    const displayName = name.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/[;,]/g, '').trim() || 'Unknown';
    for (const phone of phones) {
      if (seen.has(phone)) continue;
      seen.add(phone);
      contacts.push({ phone, name: displayName });
    }
  }
  return contacts;
}
