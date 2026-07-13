try {
  const electron = require('electron');
  const fs = require('fs');
  fs.writeFileSync(require('os').homedir() + '/test_electron.log', 'Electron loaded: ' + !!electron.app);
} catch (e) {
  const fs = require('fs');
  fs.writeFileSync(require('os').homedir() + '/test_electron.log', 'Error: ' + e.stack);
}
