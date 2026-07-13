const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'src', 'adapter.ts');
let content = fs.readFileSync(p, 'utf8');
content = content.replace(
  "this.childProcess = spawn(codexBin, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', 'stdio://']);",
  "this.childProcess = spawn(codexBin, ['-c', 'features.code_mode_host=true', '-c', 'features.enable_mcp_apps=false', 'app-server', '--listen', 'stdio://']);"
);
fs.writeFileSync(p, content);
