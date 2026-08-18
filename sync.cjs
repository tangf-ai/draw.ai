const fs = require('fs')
const path = require('path')

const disableUpdatePath = path.join(__dirname, 'src/main', 'disableUpdate.js')

//Enable/disable updates
fs.writeFileSync(disableUpdatePath, 'export function disableUpdate() { return ' + (process.argv[2] == 'disableUpdate'? 'true' : 'false') + ';}', 'utf8');
