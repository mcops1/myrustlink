// Patches rustplus.js protobuf schema — replaces ALL `required` with `optional`.
// Rust servers omit fields with default values; protobuf2 `required` throws a
// ProtocolError crash when any required field is missing. Making everything
// optional prevents crashes when the game server omits zero-value fields.
const fs = require('fs');
const f = 'node_modules/@liamcottle/rustplus.js/rustplus.proto';
let content = fs.readFileSync(f, 'utf8');
const before = content;
content = content.replace(/\brequired\b/g, 'optional');
const count = (before.match(/\brequired\b/g) || []).length;
fs.writeFileSync(f, content);
console.log(`Patched ${count} required -> optional in ${f}`);
