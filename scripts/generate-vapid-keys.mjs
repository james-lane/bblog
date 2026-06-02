import { generateKeyPairSync } from 'node:crypto';

function base64UrlToBuffer(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(
    padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='),
    'base64',
  );
}

function bufferToBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });
const publicBytes = Buffer.concat([
  Buffer.from([0x04]),
  base64UrlToBuffer(publicJwk.x),
  base64UrlToBuffer(publicJwk.y),
]);

console.log('BBLOG_VAPID_PUBLIC_KEY=' + bufferToBase64Url(publicBytes));
console.log('BBLOG_VAPID_PRIVATE_KEY=' + privateJwk.d);
console.log('BBLOG_VAPID_SUBJECT=mailto:you@example.com');
