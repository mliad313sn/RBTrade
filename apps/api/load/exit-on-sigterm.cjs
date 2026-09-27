// Preloaded into the api by `platform-load.mjs --prof`: exit cleanly on SIGTERM so --cpu-prof is written.
process.on('SIGTERM', () => process.exit(0));
