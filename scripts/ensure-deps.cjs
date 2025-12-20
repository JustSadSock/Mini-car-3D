#!/usr/bin/env node
try {
  require.resolve('@dimforge/rapier3d-compat');
} catch (err) {
  console.error('Missing @dimforge/rapier3d-compat. Run: npm install');
  process.exit(1);
}
