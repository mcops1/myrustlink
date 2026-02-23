// Patches rustplus.js protobuf schema to make SellOrder fields optional.
// Rust servers omit fields with default values, causing ProtocolError crashes.
const fs = require('fs');
const f = 'node_modules/@liamcottle/rustplus.js/rustplus.proto';
let content = fs.readFileSync(f, 'utf8');
const fields = ['amountInStock', 'itemIsBlueprint', 'currencyIsBlueprint', 'itemCondition', 'itemConditionMax'];
let count = 0;
for (const field of fields) {
  const before = content;
  content = content.replace(`required int32 ${field}`, `optional int32 ${field}`);
  content = content.replace(`required bool ${field}`, `optional bool ${field}`);
  content = content.replace(`required float ${field}`, `optional float ${field}`);
  if (content !== before) count++;
}
fs.writeFileSync(f, content);
console.log(`Patched ${count} field(s) in ${f}`);
