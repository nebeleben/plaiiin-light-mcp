// Preloaded into the built server by stdio.test.ts: a dependency logging with console.log after startup
// (as omggif does on a truncated GIF stream) must end up on stderr, not on the JSON-RPC stdout.
setTimeout(() => { console.log('Warning, gif stream longer than expected.'); console.info('bonjour noise'); }, 300);
