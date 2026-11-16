import { Console } from 'node:console';

/**
 * stdout carries the MCP JSON-RPC stream, so nothing else may write to it. Some dependencies log with
 * `console.log` (omggif on a truncated GIF, bonjour-service): send every console method to stderr.
 */
export function consoleToStderr(stream: NodeJS.WritableStream = process.stderr): void {
  globalThis.console = new Console({ stdout: stream, stderr: stream });
}
