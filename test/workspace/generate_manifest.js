// Simple script to manually trigger manifest generation
// This ensures the plugin is loaded and will generate the manifest
require('./.pnp.cjs').setup();
require('../../plugin/dist/plugin-yarnpnp2nix.js');
