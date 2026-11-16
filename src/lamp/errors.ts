import { scrub } from '../util/scrub';

/** The lamp answered with a non-2xx status. `message` is the firmware's text (JSON `message`/`error` unwrapped), scrubbed. */
export class LampHttpError extends Error {
  readonly body: string;
  constructor(readonly status: number, body: string) {
    const clean = scrub(body);
    super(clean);
    this.name = 'LampHttpError';
    this.body = clean;
  }
}

/** No (timely) answer: refused, unreachable, reset, or timed out. */
export class LampUnreachable extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = 'LampUnreachable';
  }
}
