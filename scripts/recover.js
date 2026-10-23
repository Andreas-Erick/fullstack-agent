// Emergency recovery if a self-change broke the app so badly it won't start:
//   npm run recover          → list recent changes
//   npm run recover -- undo  → revert the most recent change
//   npm run recover -- <id>  → restore the app to that version
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Nexus Agent', '-c', 'user.email=nexus-agent@localhost', ...args], { cwd: root, encoding: 'utf8' });

const arg = process.argv[2];
try {
  if (!arg) {
    console.log('Recent changes (newest first):\n');
    console.log(git('log', '-n15', '--pretty=format:  %h  %cr  %s'));
    console.log('\n\nUndo the latest:   npm run recover -- undo\nRestore a version: npm run recover -- <id>');
  } else if (arg === 'undo') {
    git('restore', '--staged', '--worktree', '--', '.');
    git('revert', '--no-edit', 'HEAD');
    console.log('Reverted the latest change. Start the app again with: npm start');
  } else {
    git('restore', '--staged', '--worktree', '--', '.');
    git('restore', `--source=${arg}`, '--staged', '--worktree', '--', '.');
    git('commit', '-q', '-m', `Restore to ${arg} (recovery)`);
    console.log(`Restored to ${arg}. Start the app again with: npm start`);
  }
} catch (err) {
  console.error(String(err.stderr || err.message));
  process.exit(1);
}
