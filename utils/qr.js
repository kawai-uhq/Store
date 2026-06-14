// utils/qr.js — build a BIP21 litecoin URI and render it to a PNG QR buffer.

const QRCode = require('qrcode');

// litecoin:<address>?amount=<ltc>&label=<label>
function bip21(address, ltcAmount, label) {
  let uri = `litecoin:${address}?amount=${ltcAmount}`;
  if (label) uri += `&label=${encodeURIComponent(label)}`;
  return uri;
}

async function makeQrBuffer(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

module.exports = { bip21, makeQrBuffer };
