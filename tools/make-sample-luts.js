// node tools/make-sample-luts.js  → writes the demo looks as .cube files into samples/luts
const fs = require('fs'), path = require('path');
const Cube = require('../js/cube.js');
const out = path.join(__dirname, '..', 'samples', 'luts');
fs.mkdirSync(out, { recursive: true });
for (const look of Cube.demoLooks(33)) fs.writeFileSync(path.join(out, look.name.replace(/[^\w &-]/g, '') + '.cube'), Cube.toCube(look));
console.log('wrote', fs.readdirSync(out).length, 'LUTs to', out);
